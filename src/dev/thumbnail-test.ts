import 'vite/modulepreload-polyfill';

// The browser fixture shares the same compiled singleton as production components.
export { videoThumbnails } from '../renderer/components/preview-thumbnails';
