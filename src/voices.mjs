// Voices you can pick per video (dashboard dropdown, or "voice" in the API). The choice is saved on the
// video's steps, so re-recording keeps the same voice. ElevenLabs voices are tried by ID, then by name.
export const VOICES = [
  { id: 'paul', label: 'Paul (Voxtral)', model: 'mistralai/voxtral-mini-tts-3-0', voices: ['en_paul_neutral'], usdPerMChar: 13 },
  { id: 'sarah-v4', label: 'Sarah (ElevenLabs v4)', model: 'elevenlabs/eleven-v4', voices: ['EXAVITQu4vr4xnSDxMaL', 'Sarah'], usdPerMChar: 80 },
  { id: 'sarah-turbo', label: 'Sarah (ElevenLabs v4 Turbo, half price)', model: 'elevenlabs/eleven-v4-turbo', voices: ['EXAVITQu4vr4xnSDxMaL', 'Sarah'], usdPerMChar: 40 },
];

// The default comes from TTS_MODEL / TTS_VOICE on the service (Paul if unset).
import { get } from './settings.mjs';
export function defaultVoice() {
  const picked = VOICES.find((v) => v.id === get('voice'));
  if (picked) return picked;
  const model = process.env.TTS_MODEL || 'mistralai/voxtral-mini-tts-3-0';
  const voice = process.env.TTS_VOICE || 'en_paul_neutral';
  return VOICES.find((v) => v.model === model && v.voices.includes(voice))
    || { id: 'default', label: `${voice} (${model})`, model, voices: [voice], usdPerMChar: Number(process.env.TTS_USD_PER_MCHAR || 13) };
}

export const voiceById = (id) => VOICES.find((v) => v.id === id) || defaultVoice();
export const isVoice = (id) => VOICES.some((v) => v.id === id);

// Price per video at a glance, for the dropdown (a typical video speaks about 600 characters).
export const perVideo = (v) => `about ${((v.usdPerMChar * 600) / 1e6 * 100).toFixed(1)}¢ a video`;
