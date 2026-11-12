import { Server } from 'lucide-react';
import type { ModelPlatform } from '@video-quickly/contracts';

const icons = import.meta.glob<string>('../assets/platforms/*.svg', { eager: true, query: '?url', import: 'default' });

export default function PlatformIcon({ platform }: { platform: ModelPlatform }) {
  const source = icons[`../assets/platforms/${platform}.svg`];
  return source ? <img className={`platform-icon ${['openai', 'openrouter', 'ollama', 'moonshot'].includes(platform) ? 'platform-icon--mono' : ''}`} src={source} alt="" aria-hidden="true" width="24" height="24" /> : <Server className="platform-icon" aria-hidden="true" size={24} />;
}
