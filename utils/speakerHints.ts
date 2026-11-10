import { SpeakerHint } from '../types';

// 轉錄前填的講者；記在這台裝置上，重新整理或續傳時不用再填
const STORAGE_KEY = 'transcription_speakers';

export const loadSpeakerHints = (): SpeakerHint[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved)
      ? saved.filter(h => typeof h?.name === 'string' && typeof h?.role === 'string').map(h => ({ name: h.name, role: h.role }))
      : [];
  } catch {
    return [];
  }
};

export const saveSpeakerHints = (hints: SpeakerHint[]): void => {
  try {
    if (hints.some(h => h.name.trim() || h.role.trim())) localStorage.setItem(STORAGE_KEY, JSON.stringify(hints));
    else localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to save speaker hints:', error);
  }
};
