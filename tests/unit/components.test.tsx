// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SpeakerPanel from '../../components/SpeakerPanel';
import ApiKeyModal from '../../components/ApiKeyModal';
import TranscriptRow from '../../components/TranscriptRow';

// jsdom 沒有 ResizeObserver（文字框自動調整高度用的），給一個不做事的版本
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SpeakerPanel', () => {
  const setup = () => {
    const onRename = vi.fn();
    render(<SpeakerPanel speakers={[{ name: '講者 1', count: 6 }, { name: '講者 2', count: 3 }]} onRename={onRename} />);
    return onRename;
  };

  it('列出講者與段數', () => {
    setup();
    expect(screen.getByText('6 段')).toBeTruthy();
    expect(screen.getByText('3 段')).toBeTruthy();
  });

  it('按 Enter 套用新名稱（前後空白會去掉）', () => {
    const onRename = setup();
    const input = screen.getByLabelText('講者 1 的新名稱');
    fireEvent.change(input, { target: { value: '  王經理 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith('講者 1', '王經理');
  });

  it('空白或沒改名稱時不套用，並還原原名', () => {
    const onRename = setup();
    const input = screen.getByLabelText('講者 2 的新名稱') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    fireEvent.blur(screen.getByLabelText('講者 1 的新名稱'));
    expect(onRename).not.toHaveBeenCalled();
    expect(input.value).toBe('講者 2');
  });
});

describe('ApiKeyModal', () => {
  const setup = (currentKey = '') => {
    const props = { isOpen: true, onClose: vi.fn(), onSave: vi.fn(), onClear: vi.fn(), currentKey };
    render(<ApiKeyModal {...props} />);
    return props;
  };

  it('在輸入框按 Enter 就儲存', () => {
    const { onSave, onClose } = setup();
    const input = screen.getByLabelText('API Key');
    fireEvent.change(input, { target: { value: ' AIza-new ' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSave).toHaveBeenCalledWith('AIza-new');
    expect(onClose).toHaveBeenCalled();
  });

  it('儲存前先確認：無效的金鑰不儲存並說明', async () => {
    const props = { isOpen: true, onClose: vi.fn(), onSave: vi.fn(), onClear: vi.fn(), currentKey: '', validate: vi.fn().mockResolvedValue('invalid') };
    render(<ApiKeyModal {...props} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByLabelText('API Key').closest('form')!);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('這組 API Key 無效');
    expect(props.validate).toHaveBeenCalledWith('wrong');
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each(['valid', 'unknown'] as const)('確認結果為 %s 時儲存', async result => {
    const props = { isOpen: true, onClose: vi.fn(), onSave: vi.fn(), onClear: vi.fn(), currentKey: '', validate: vi.fn().mockResolvedValue(result) };
    render(<ApiKeyModal {...props} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'AIza-ok' } });
    fireEvent.submit(screen.getByLabelText('API Key').closest('form')!);
    await vi.waitFor(() => expect(props.onSave).toHaveBeenCalledWith('AIza-ok'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('空白時不能儲存', () => {
    const { onSave } = setup();
    expect((screen.getByRole('button', { name: /儲存/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText('API Key').closest('form')!);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('按 Esc 關閉', () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('沒有金鑰時不顯示「清除 API Key」', () => {
    setup();
    expect(screen.queryByRole('button', { name: /清除 API Key/ })).toBeNull();
  });

  it('清除 API Key前先確認', () => {
    const { onClear } = setup('AIza-old');
    const confirm = vi.spyOn(window, 'confirm');
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /清除 API Key/ }));
    expect(onClear).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /清除 API Key/ }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('TranscriptRow', () => {
  const setup = () => {
    const onUpdate = vi.fn();
    render(<TranscriptRow index={4} onUpdate={onUpdate} segment={{ id: 'x', speaker: 'John', timestamp: '', startTimeSeconds: 65, text: '內容' }} />);
    return onUpdate;
  };

  it('講者名稱照輸入顯示（不轉大寫）', () => {
    setup();
    const speaker = screen.getByLabelText('講者') as HTMLInputElement;
    expect(speaker.value).toBe('John');
    expect(speaker.className).not.toContain('uppercase');
  });

  it('修改時間：有效時回報秒數', () => {
    const onUpdate = setup();
    const time = screen.getByLabelText('開始時間') as HTMLInputElement;
    expect(time.value).toBe('01:05');
    fireEvent.change(time, { target: { value: '1:02:03' } });
    fireEvent.blur(time);
    expect(onUpdate).toHaveBeenCalledWith(4, 'startTimeSeconds', 3723);
  });

  it('修改時間：無效時還原，不回報', () => {
    const onUpdate = setup();
    const time = screen.getByLabelText('開始時間') as HTMLInputElement;
    fireEvent.change(time, { target: { value: 'abc' } });
    fireEvent.blur(time);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(time.value).toBe('01:05');
  });

  it('修改文字與講者', () => {
    const onUpdate = setup();
    fireEvent.change(screen.getByLabelText('逐字稿內容'), { target: { value: '新內容' } });
    fireEvent.change(screen.getByLabelText('講者'), { target: { value: '王經理' } });
    expect(onUpdate).toHaveBeenCalledWith(4, 'text', '新內容');
    expect(onUpdate).toHaveBeenCalledWith(4, 'speaker', '王經理');
  });
});
