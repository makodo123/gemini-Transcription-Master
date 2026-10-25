/**
 * 分段解碼：不把整個檔案交給 decodeAudioData（它會先以原始取樣率解出整個檔案，一小時立體聲約 1.4GB 以上），
 * 而是自己讀出壓縮音框，分批交給 WebCodecs AudioDecoder，解出一批就立刻下混、重新取樣成 16kHz 並寫入結果。
 * 支援 WAV（直接讀取）、MP3、M4A/MP4（AAC）。其他格式或瀏覽器不支援時回傳 null，由呼叫端改用整檔解碼。
 */

export interface StreamDecodeOptions {
  outputRate: number;
  signal?: AbortSignal;
  /** 解碼進度 0–1 */
  onProgress?: (fraction: number) => void;
}

// ---------- 重新取樣 ----------

/** 每側包含的 sinc 零點數，越多越精確、越慢；6 對語音辨識已足夠 */
const SINC_ZEROS = 6;
/** 每個輸入樣本間隔的核函數取樣數 */
const KERNEL_PHASES = 128;

/**
 * 串流式 windowed-sinc 重新取樣：分批輸入，批次之間沒有接縫。
 */
class Resampler {
  private readonly step: number;
  private readonly halfWidth: number;
  private readonly kernel: Float32Array;
  // buffer[0] 對應的輸入樣本絕對位置；開頭補零，第一個輸出樣本也有完整的左側
  private bufferStart: number;
  private buffer: Float32Array;
  private totalIn = 0;
  private nextOut = 0;

  constructor(inRate: number, outRate: number) {
    this.step = inRate / outRate;
    // 截止頻率（相對於輸入的 Nyquist）：降頻時壓到輸出 Nyquist 以下避免混疊
    const cutoff = Math.min(1, outRate / inRate) * 0.9;
    this.halfWidth = Math.ceil(SINC_ZEROS / cutoff);
    const w = this.halfWidth;
    this.kernel = new Float32Array(2 * w * KERNEL_PHASES + 1);
    for (let i = 0; i < this.kernel.length; i++) {
      const x = i / KERNEL_PHASES - w;
      const u = cutoff * x;
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / w);
      this.kernel[i] = cutoff * sinc * window;
    }
    this.bufferStart = -w;
    this.buffer = new Float32Array(w);
  }

  /** 輸入一批樣本，回傳目前可以算出的輸出樣本 */
  push(input: Float32Array): Float32Array {
    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer);
    merged.set(input, this.buffer.length);
    this.buffer = merged;
    this.totalIn += input.length;
    return this.drain(false);
  }

  /** 輸入結束：右側補零，算出剩下的輸出樣本 */
  flush(): Float32Array {
    const padded = new Float32Array(this.buffer.length + this.halfWidth + 1);
    padded.set(this.buffer);
    this.buffer = padded;
    return this.drain(true);
  }

  private drain(final: boolean): Float32Array {
    const w = this.halfWidth;
    const bufferEnd = this.bufferStart + this.buffer.length;
    const out = new Float32Array(Math.max(0, Math.ceil((bufferEnd - this.nextOut * this.step) / this.step)) + 1);
    let count = 0;
    for (;;) {
      const center = this.nextOut * this.step;
      if (final ? center >= this.totalIn : center + w + 1 > bufferEnd) break;
      const base = Math.floor(center);
      // 第一個 tap 是 base - w + 1，距離 center 為 frac + w - 1，換算成核函數索引後每個 tap 遞減一個間隔
      let k = Math.round((center - (base - w + 1) + w) * KERNEL_PHASES);
      let pos = base - w + 1 - this.bufferStart;
      let acc = 0;
      for (let t = 0; t < 2 * w; t++) {
        acc += this.buffer[pos++] * this.kernel[k];
        k -= KERNEL_PHASES;
      }
      out[count++] = acc;
      this.nextOut++;
    }
    // 丟掉之後用不到的輸入
    const keepFrom = Math.floor(this.nextOut * this.step) - w + 1;
    if (keepFrom > this.bufferStart) {
      this.buffer = this.buffer.slice(keepFrom - this.bufferStart);
      this.bufferStart = keepFrom;
    }
    return out.subarray(0, count);
  }
}

// ---------- 輸出 ----------

/** 把 16kHz float 樣本轉成 16-bit 寫入；預先依預估長度配置，不足時才擴充 */
class PcmWriter {
  private data: Int16Array;
  length = 0;

  constructor(estimatedLength: number) {
    this.data = new Int16Array(Math.max(1, Math.ceil(estimatedLength)));
  }

  write(samples: Float32Array) {
    if (this.length + samples.length > this.data.length) {
      const grown = new Int16Array(Math.max(this.length + samples.length, Math.ceil(this.data.length * 1.25)));
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      this.data[this.length++] = s < 0 ? s * 32768 : s * 32767;
    }
  }

  result(): Int16Array {
    return this.data.subarray(0, this.length);
  }
}

/** 多聲道平均成單聲道，送進重新取樣再寫入 */
class MonoSink {
  private resampler: Resampler | null = null;
  private inRate = 0;
  readonly writer: PcmWriter;

  constructor(private readonly outputRate: number, estimatedOutputLength: number) {
    this.writer = new PcmWriter(estimatedOutputLength);
  }

  write(channels: Float32Array[], sampleRate: number) {
    if (!this.resampler) {
      this.inRate = sampleRate;
      this.resampler = new Resampler(sampleRate, this.outputRate);
    } else if (sampleRate !== this.inRate) {
      throw new Error(`Sample rate changed mid-stream (${this.inRate} → ${sampleRate})`);
    }
    const frames = channels[0].length;
    let mono = channels[0];
    if (channels.length > 1) {
      mono = new Float32Array(frames);
      for (const channel of channels) {
        for (let i = 0; i < frames; i++) mono[i] += channel[i];
      }
      for (let i = 0; i < frames; i++) mono[i] /= channels.length;
    }
    this.writer.write(this.resampler.push(mono));
  }

  finish(): Int16Array {
    if (this.resampler) this.writer.write(this.resampler.flush());
    return this.writer.result();
  }
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Decoding aborted', 'AbortError');
};

const readBytes = async (file: Blob, start: number, end: number): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(start, end).arrayBuffer());

const fourCC = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

// ---------- WAV ----------

const WAV_BLOCK_FRAMES = 1 << 20;

const decodeWav = async (file: File, options: StreamDecodeOptions): Promise<Int16Array | null> => {
  const head = await readBytes(file, 0, 12);
  if (fourCC(head, 0) !== 'RIFF' || fourCC(head, 8) !== 'WAVE') return null;

  let format = 0, channels = 0, sampleRate = 0, bits = 0, blockAlign = 0;
  let dataStart = -1, dataLength = 0;
  let pos = 12;
  for (let i = 0; i < 64 && pos + 8 <= file.size; i++) {
    const chunkHeader = await readBytes(file, pos, pos + 8);
    const view = new DataView(chunkHeader.buffer);
    const id = fourCC(chunkHeader, 0);
    const size = view.getUint32(4, true);
    if (id === 'fmt ') {
      const fmt = new DataView((await readBytes(file, pos + 8, pos + 8 + Math.min(size, 40))).buffer);
      format = fmt.getUint16(0, true);
      channels = fmt.getUint16(2, true);
      sampleRate = fmt.getUint32(4, true);
      blockAlign = fmt.getUint16(12, true);
      bits = fmt.getUint16(14, true);
      // WAVE_FORMAT_EXTENSIBLE：實際格式在 SubFormat GUID 的前兩個位元組
      if (format === 0xfffe && size >= 26) format = fmt.getUint16(24, true);
    } else if (id === 'data') {
      dataStart = pos + 8;
      // 串流錄音軟體常把長度寫成 0 或 0xFFFFFFFF，以檔案實際大小為準
      dataLength = size === 0 || size === 0xffffffff ? file.size - dataStart : Math.min(size, file.size - dataStart);
      break;
    }
    pos += 8 + size + (size % 2);
  }

  const supported = (format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && bits === 32);
  if (dataStart < 0 || !supported || channels < 1 || !sampleRate || blockAlign !== channels * (bits / 8)) return null;

  const totalFrames = Math.floor(dataLength / blockAlign);
  const sink = new MonoSink(options.outputRate, (totalFrames * options.outputRate) / sampleRate + 1);
  const bytesPerSample = bits / 8;

  for (let frame = 0; frame < totalFrames; frame += WAV_BLOCK_FRAMES) {
    throwIfAborted(options.signal);
    const frames = Math.min(WAV_BLOCK_FRAMES, totalFrames - frame);
    const start = dataStart + frame * blockAlign;
    const bytes = await readBytes(file, start, start + frames * blockAlign);
    const view = new DataView(bytes.buffer);
    const planes = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const offset = i * blockAlign + c * bytesPerSample;
        let value: number;
        if (format === 3) value = view.getFloat32(offset, true);
        else if (bits === 8) value = (bytes[offset] - 128) / 128;
        else if (bits === 16) value = view.getInt16(offset, true) / 32768;
        else if (bits === 24) value = ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) << 8 >> 8) / 8388608;
        else value = view.getInt32(offset, true) / 2147483648;
        planes[c][i] = value;
      }
    }
    sink.write(planes, sampleRate);
    options.onProgress?.((frame + frames) / totalFrames);
  }
  return sink.finish();
};

// ---------- 壓縮格式共用：音框表 + AudioDecoder ----------

interface FrameTable {
  config: AudioDecoderConfig;
  offsets: number[];
  sizes: number[];
  /** 預估總長度（秒），用來預先配置輸出 */
  durationSeconds: number;
}

/** 一次從檔案讀取的音框範圍上限 */
const BATCH_MAX_BYTES = 4 * 1024 * 1024;
const BATCH_MAX_FRAMES = 2000;
/** 解碼佇列上限，避免一次塞太多壓縮資料 */
const MAX_DECODE_QUEUE = 64;

const decodeFrameTable = async (file: File, table: FrameTable, options: StreamDecodeOptions): Promise<Int16Array> => {
  const sink = new MonoSink(options.outputRate, table.durationSeconds * options.outputRate + options.outputRate);
  let decodeError: unknown = null;
  let frameDuration = 0;

  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        if (decodeError) return;
        const planes = Array.from({ length: data.numberOfChannels }, (_, c) => {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          return plane;
        });
        sink.write(planes, data.sampleRate);
        frameDuration ||= data.numberOfFrames / data.sampleRate;
      } catch (error) {
        decodeError = error;
      } finally {
        data.close();
      }
    },
    error: (error) => { decodeError = error; },
  });

  try {
    decoder.configure(table.config);
    const total = table.offsets.length;
    let timestamp = 0;

    for (let first = 0; first < total;) {
      throwIfAborted(options.signal);
      if (decodeError) throw decodeError;

      // 取一批位置連續的音框，整段讀進來
      const start = table.offsets[first];
      let last = first;
      while (
        last + 1 < total &&
        last + 1 - first < BATCH_MAX_FRAMES &&
        table.offsets[last + 1] >= start &&
        table.offsets[last + 1] + table.sizes[last + 1] - start <= BATCH_MAX_BYTES
      ) last++;
      const end = Math.max(...table.offsets.slice(first, last + 1).map((o, i) => o + table.sizes[first + i]));
      const bytes = await readBytes(file, start, end);

      for (let i = first; i <= last; i++) {
        const offset = table.offsets[i] - start;
        decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(timestamp * 1e6),
          data: bytes.subarray(offset, offset + table.sizes[i]),
        }));
        timestamp += frameDuration;
        while (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
          // 不支援 dequeue 事件的瀏覽器靠逾時繼續，不會卡住
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 20);
            decoder.addEventListener('dequeue', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      }
      first = last + 1;
      options.onProgress?.(first / total);
    }

    await decoder.flush();
    if (decodeError) throw decodeError;
    return sink.finish();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
};

const isSupported = async (config: AudioDecoderConfig): Promise<boolean> => {
  try {
    return !!(await AudioDecoder.isConfigSupported(config)).supported;
  } catch {
    return false;
  }
};

// ---------- MP3 ----------

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;

interface Mp3Header { length: number; sampleRate: number; channels: number; samplesPerFrame: number; version: number }

/** 解析 MPEG Layer III 音框標頭，不是有效標頭時回傳 null */
const parseMp3Header = (b: Uint8Array, i: number): Mp3Header | null => {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3;
  const layer = (b[i + 1] >> 1) & 3;
  const bitrateIndex = b[i + 2] >> 4;
  const rateIndex = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const sampleRate = MP3_SAMPLE_RATES[version][rateIndex];
  const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] * 1000;
  const padding = (b[i + 2] >> 1) & 1;
  const length = Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return { length, sampleRate, channels: b[i + 3] >> 6 === 3 ? 1 : 2, samplesPerFrame: version === 3 ? 1152 : 576, version };
};

const MP3_SCAN_BLOCK = 4 * 1024 * 1024;
/** 開頭這個範圍內找不到 MP3 音框，就不是 MP3（避免把其他格式整個逐位元組掃過） */
const MP3_SYNC_SEARCH_BYTES = 64 * 1024;

const scanMp3 = async (file: File): Promise<FrameTable | null> => {
  let pos = 0;
  const id3 = await readBytes(file, 0, 10);
  if (fourCC(id3, 0).startsWith('ID3')) {
    const size = (id3[6] << 21) | (id3[7] << 14) | (id3[8] << 7) | id3[9];
    pos = 10 + size + (id3[5] & 0x10 ? 10 : 0);
  }

  let block = new Uint8Array(0);
  let blockStart = 0;
  // 確保 [offset, offset + length) 在已讀入的區塊內
  const ensure = async (offset: number, length: number) => {
    if (offset < blockStart || offset + length > blockStart + block.length) {
      block = await readBytes(file, offset, offset + MP3_SCAN_BLOCK);
      blockStart = offset;
    }
    return offset + length <= blockStart + block.length;
  };

  const offsets: number[] = [];
  const sizes: number[] = [];
  let ref: Mp3Header | null = null;
  const syncSearchEnd = pos + MP3_SYNC_SEARCH_BYTES;

  while (pos + 4 <= file.size) {
    if (!ref && pos > syncSearchEnd) return null;
    if (!(await ensure(pos, 4))) break;
    const header = parseMp3Header(block, pos - blockStart);
    const matches = header && pos + header.length <= file.size &&
      (ref ? header.sampleRate === ref.sampleRate && header.version === ref.version : true);
    if (header && matches) {
      if (!ref) {
        // 第一個音框要確認下一個標頭也對得上，避免把雜訊誤認成音框
        const next = pos + header.length;
        if (!(await ensure(pos, header.length + 4))) break;
        const nextHeader = parseMp3Header(block, next - blockStart);
        if (!nextHeader || nextHeader.sampleRate !== header.sampleRate) { pos++; continue; }
        ref = header;
        // 第一個音框若是 Xing/Info/VBRI 標頭，內容只是靜音，跳過
        const sideInfo = header.version === 3 ? (header.channels === 1 ? 17 : 32) : (header.channels === 1 ? 9 : 17);
        const tagAt = pos - blockStart + 4;
        if (['Xing', 'Info'].includes(fourCC(block, tagAt + sideInfo)) || fourCC(block, tagAt + 32) === 'VBRI') {
          pos += header.length;
          continue;
        }
      }
      offsets.push(pos);
      sizes.push(header.length);
      pos += header.length;
    } else {
      pos++; // 失去同步（標籤、雜訊）時逐位元組找下一個音框
    }
  }

  if (!ref || offsets.length === 0) return null;
  return {
    config: { codec: 'mp3', sampleRate: ref.sampleRate, numberOfChannels: ref.channels },
    offsets,
    sizes,
    durationSeconds: (offsets.length * ref.samplesPerFrame) / ref.sampleRate,
  };
};

// ---------- MP4 / M4A ----------

interface Mp4Box { type: string; start: number; end: number; payload: number }

/** 列出 [start, end) 範圍內的子 box */
const listBoxes = (b: Uint8Array, start: number, end: number): Mp4Box[] => {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const boxes: Mp4Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    boxes.push({ type: fourCC(b, pos + 4), start: pos, end: pos + size, payload: pos + header });
    pos += size;
  }
  return boxes;
};

const findBox = (b: Uint8Array, parent: Mp4Box, type: string) =>
  listBoxes(b, parent.payload, parent.end).find(box => box.type === type);

const findPath = (b: Uint8Array, parent: Mp4Box, path: string[]): Mp4Box | undefined =>
  path.reduce<Mp4Box | undefined>((box, type) => box && findBox(b, box, type), parent);

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** 從 esds 取出 objectTypeIndication 與 DecoderSpecificInfo（AAC 的 AudioSpecificConfig） */
const parseEsds = (b: Uint8Array, esds: Mp4Box): { objectType: number; config?: Uint8Array } | null => {
  let pos = esds.payload + 4;
  const readDescriptor = () => {
    const tag = b[pos++];
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const byte = b[pos++];
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return { tag, length, start: pos };
  };

  const es = readDescriptor();
  if (es.tag !== 0x03) return null;
  pos += 2; // ES_ID
  const flags = b[pos++];
  if (flags & 0x80) pos += 2;
  if (flags & 0x40) pos += 1 + b[pos];
  if (flags & 0x20) pos += 2;

  const decoderConfig = readDescriptor();
  if (decoderConfig.tag !== 0x04) return null;
  const objectType = b[pos];
  pos += 13;
  if (pos >= decoderConfig.start + decoderConfig.length) return { objectType };
  const specific = readDescriptor();
  return { objectType, config: specific.tag === 0x05 ? b.slice(specific.start, specific.start + specific.length) : undefined };
};

const readMp4Moov = async (file: File): Promise<Uint8Array | null> => {
  let pos = 0;
  for (let i = 0; i < 1000 && pos + 8 <= file.size; i++) {
    const header = await readBytes(file, pos, pos + 16);
    const view = new DataView(header.buffer);
    let size = view.getUint32(0);
    const type = fourCC(header, 4);
    if (i === 0 && type !== 'ftyp') return null;
    if (size === 1) size = Number(view.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) return null;
    if (type === 'moov') return readBytes(file, pos, pos + size);
    pos += size;
  }
  return null;
};

const scanMp4 = async (file: File): Promise<FrameTable | null> => {
  const b = await readMp4Moov(file);
  if (!b) return null;
  const view = new DataView(b.buffer);
  const moov = listBoxes(b, 0, b.length)[0];
  // fragmented MP4 的音框表在各個 moof 裡，交給整檔解碼
  if (!moov || moov.type !== 'moov' || findBox(b, moov, 'mvex')) return null;

  for (const trak of listBoxes(b, moov.payload, moov.end).filter(box => box.type === 'trak')) {
    const hdlr = findPath(b, trak, ['mdia', 'hdlr']);
    if (!hdlr || fourCC(b, hdlr.payload + 8) !== 'soun') continue;
    const mdhd = findPath(b, trak, ['mdia', 'mdhd']);
    const stbl = findPath(b, trak, ['mdia', 'minf', 'stbl']);
    if (!mdhd || !stbl) return null;
    const timescale = view.getUint32(mdhd.payload + (b[mdhd.payload] === 1 ? 20 : 12));

    const stsd = findBox(b, stbl, 'stsd');
    const stsz = findBox(b, stbl, 'stsz');
    const stsc = findBox(b, stbl, 'stsc');
    const stco = findBox(b, stbl, 'stco') ?? findBox(b, stbl, 'co64');
    const stts = findBox(b, stbl, 'stts');
    if (!stsd || !stsz || !stsc || !stco || !stts) return null;

    // 取樣描述：只處理 mp4a（AAC 或 MP3），ALAC 等其他編碼交給整檔解碼
    const entry = listBoxes(b, stsd.payload + 8, stsd.end)[0];
    if (!entry || entry.type !== 'mp4a') return null;
    const entryVersion = view.getUint16(entry.payload + 8);
    let channels = view.getUint16(entry.payload + 16);
    let sampleRate = view.getUint32(entry.payload + 24) >>> 16;
    const childrenStart = entry.payload + 28 + (entryVersion === 1 ? 16 : entryVersion === 2 ? 36 : 0);
    const children = { type: 'mp4a', start: entry.start, end: entry.end, payload: childrenStart };
    const esdsBox = findBox(b, children, 'esds') ?? findPath(b, children, ['wave', 'esds']);
    const esds = esdsBox && parseEsds(b, esdsBox);
    if (!esds) return null;

    let config: AudioDecoderConfig;
    if (esds.objectType === 0x40 && esds.config && esds.config.length >= 2) {
      const asc = esds.config;
      const audioObjectType = asc[0] >> 3;
      const rateIndex = ((asc[0] & 7) << 1) | (asc[1] >> 7);
      const channelConfig = (asc[1] >> 3) & 15;
      if (rateIndex < AAC_SAMPLE_RATES.length) sampleRate = AAC_SAMPLE_RATES[rateIndex];
      if (channelConfig > 0 && channelConfig < 8) channels = channelConfig;
      config = { codec: `mp4a.40.${audioObjectType}`, sampleRate, numberOfChannels: channels, description: asc };
    } else if (esds.objectType === 0x69 || esds.objectType === 0x6b) {
      config = { codec: 'mp3', sampleRate, numberOfChannels: channels };
    } else {
      return null;
    }

    // 音框大小
    const fixedSize = view.getUint32(stsz.payload + 4);
    const count = view.getUint32(stsz.payload + 8);
    if (count === 0) return null;
    const sizes = Array.from({ length: count }, (_, i) => fixedSize || view.getUint32(stsz.payload + 12 + i * 4));

    // chunk 起點
    const is64 = stco.type === 'co64';
    const chunkCount = view.getUint32(stco.payload + 4);
    const chunkOffsets = Array.from({ length: chunkCount }, (_, i) =>
      is64 ? Number(view.getBigUint64(stco.payload + 8 + i * 8)) : view.getUint32(stco.payload + 8 + i * 4));

    // 依 sample-to-chunk 表算出每個音框的位置
    const runs = view.getUint32(stsc.payload + 4);
    const offsets: number[] = [];
    for (let r = 0; r < runs && offsets.length < count; r++) {
      const firstChunk = view.getUint32(stsc.payload + 8 + r * 12);
      const perChunk = view.getUint32(stsc.payload + 12 + r * 12);
      const nextFirst = r + 1 < runs ? view.getUint32(stsc.payload + 8 + (r + 1) * 12) : chunkCount + 1;
      for (let chunk = firstChunk; chunk < nextFirst && chunk <= chunkCount; chunk++) {
        let offset = chunkOffsets[chunk - 1];
        for (let s = 0; s < perChunk && offsets.length < count; s++) {
          offsets.push(offset);
          offset += sizes[offsets.length - 1];
        }
      }
    }
    if (offsets.length !== count || offsets.some((o, i) => o + sizes[i] > file.size)) return null;

    let durationUnits = 0;
    const sttsEntries = view.getUint32(stts.payload + 4);
    for (let i = 0; i < sttsEntries; i++) {
      durationUnits += view.getUint32(stts.payload + 8 + i * 8) * view.getUint32(stts.payload + 12 + i * 8);
    }

    return { config, offsets, sizes, durationSeconds: durationUnits / timescale };
  }
  return null;
};

// ---------- 進入點 ----------

/**
 * 分段解碼成 16-bit 單聲道 PCM；格式或瀏覽器不支援時回傳 null。
 */
export const decodeStreaming = async (file: File, options: StreamDecodeOptions): Promise<Int16Array | null> => {
  const head = await readBytes(file, 0, 12);
  if (fourCC(head, 0) === 'RIFF') return decodeWav(file, options);
  if (typeof AudioDecoder === 'undefined') return null;

  const isMp4 = fourCC(head, 4) === 'ftyp';
  const table = isMp4 ? await scanMp4(file) : await scanMp3(file);
  if (!table || !(await isSupported(table.config))) return null;
  return decodeFrameTable(file, table, options);
};
