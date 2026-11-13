import { MODEL_CHOICES, MODEL_NAME } from '../services/geminiService';

const STORAGE_KEY = 'transcription_model';

/** 讀回上次選的模型；不在選項裡（例如以後移除了）就用預設 */
export const loadModelChoice = (): string => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return MODEL_CHOICES.some(c => c.id === saved) ? saved! : MODEL_NAME;
  } catch {
    return MODEL_NAME;
  }
};

export const saveModelChoice = (model: string): void => {
  try {
    if (model === MODEL_NAME) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, model);
  } catch (error) {
    console.error('Failed to save model choice:', error);
  }
};
