// Vite serves `?raw` imports as strings; the fixtures are loaded that way so the
// tests run inside the Workers pool without touching the filesystem.
declare module '*.ics?raw' {
  const content: string;
  export default content;
}
