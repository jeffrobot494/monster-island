// dev/arena-shadow.ts: the files in src/arena/sandbox/ (paths under src/), only under the arena's Vite config
declare module 'virtual:arena-sandbox' {
  const files: string[];
  export default files;
}
