/** Public files follow Vite's base path, including GitHub Pages project sites. */
export const assetUrl = (path: string) => `${import.meta.env?.BASE_URL ?? '/'}${path.replace(/^\//, '')}`;
