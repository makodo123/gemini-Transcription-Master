import { TranscriptSegment } from "../types";

// 创建单例 AudioContext 以避免重复创建（性能优化）
let audioContext: AudioContext | null = null;

const getAudioContext = (): AudioContext => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
};

/**
 * Decodes an audio file into an AudioBuffer.
 */
export const decodeAudio = async (file: File): Promise<AudioBuffer> => {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = getAudioContext();
  return await ctx.decodeAudioData(arrayBuffer);
};

/**
 * Splits an AudioBuffer into chunks of a specified duration (in seconds).
 */
export const splitAudioBuffer = (audioBuffer: AudioBuffer, chunkDurationSeconds: number): AudioBuffer[] => {
  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const totalDuration = audioBuffer.duration;
  const chunkLengthFrames = chunkDurationSeconds * sampleRate;
  
  const chunks: AudioBuffer[] = [];
  const ctx = getAudioContext();
  
  for (let startFrame = 0; startFrame < audioBuffer.length; startFrame += chunkLengthFrames) {
    const endFrame = Math.min(startFrame + chunkLengthFrames, audioBuffer.length);
    const frameCount = endFrame - startFrame;
    const chunkBuffer = ctx.createBuffer(channels, frameCount, sampleRate);
    
    for (let channel = 0; channel < channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      // Copy the segment
      chunkBuffer.copyToChannel(channelData.subarray(startFrame, endFrame), channel);
    }
    
    chunks.push(chunkBuffer);
  }
  
  return chunks;
};

/**
 * Converts an AudioBuffer to a WAV Blob.
 * Necessary because we need to send a valid file format to Gemini.
 */
export const audioBufferToWav = (buffer: AudioBuffer): Blob => {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArr = new ArrayBuffer(length);
  const view = new DataView(bufferArr);
  const channels = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  // write WAVE header
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this encoder)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // write interleaved data
  for (i = 0; i < buffer.numberOfChannels; i++)
    channels.push(buffer.getChannelData(i));

  while (pos < buffer.length) {
    for (i = 0; i < numOfChan; i++) { // interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
      view.setInt16(44 + offset, sample, true); // write 16-bit sample
      offset += 2;
    }
    pos++;
  }

  return new Blob([bufferArr], { type: 'audio/wav' });

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
};

/**
 * Helper to convert Blob to Base64 string for Gemini API
 */
export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * Formats seconds into MM:SS or HH:MM:SS
 */
export const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  const mStr = m.toString().padStart(2, '0');
  const sStr = s.toString().padStart(2, '0');
  
  if (h > 0) {
    return `${h}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
};

/**
 * Parses a time string (e.g. "1:30", "05:12", "1:02:03") back into total seconds.
 * Returns 0 if parsing fails.
 */
export const parseTimeStringToSeconds = (timeStr: string): number => {
  try {
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.some(isNaN)) return 0;

    let seconds = 0;
    if (parts.length === 3) { // HH:MM:SS
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) { // MM:SS
      seconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 1) { // SS
      seconds = parts[0];
    }
    return seconds;
  } catch (e) {
    return 0;
  }
};

/**
 * Formats seconds into SRT timestamp format: HH:MM:SS,ms
 */
export const formatSrtTime = (seconds: number): string => {
  const totalMs = Math.floor(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(seconds);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

/**
 * Generates SRT formatted string from transcript segments
 */
export const generateSrtContent = (segments: TranscriptSegment[]): string => {
  return segments.map((segment, index) => {
    const nextSegment = segments[index + 1];
    // Estimate end time as start of next segment, or start + 5s if last
    const endTime = nextSegment ? nextSegment.startTimeSeconds : segment.startTimeSeconds + 5;
    
    return `${index + 1}
${formatSrtTime(segment.startTimeSeconds)} --> ${formatSrtTime(endTime)}
${segment.speaker}: ${segment.text}`;
  }).join('\n\n');
};