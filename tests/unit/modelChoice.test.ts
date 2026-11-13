// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadModelChoice, saveModelChoice } from '../../utils/modelChoice';
import { MODEL_NAME } from '../../services/geminiService';

beforeEach(() => localStorage.clear());

describe('modelChoice', () => {
  it('沒選過是預設；選了之後讀得回來', () => {
    expect(loadModelChoice()).toBe(MODEL_NAME);
    saveModelChoice('gemini-3.8-flash');
    expect(loadModelChoice()).toBe('gemini-3.8-flash');
  });

  it('選回預設就不再保存；不在選項裡的值當作預設', () => {
    saveModelChoice('gemini-3.6-flash');
    saveModelChoice(MODEL_NAME);
    expect(localStorage.getItem('transcription_model')).toBeNull();
    localStorage.setItem('transcription_model', 'gemini-old-retired');
    expect(loadModelChoice()).toBe(MODEL_NAME);
  });
});
