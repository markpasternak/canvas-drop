// Ambient declarations for side-effect CSS imports. TypeScript 7 checks
// side-effect imports (TS2882), and the fontsource packages resolve to bare
// CSS with no type declarations of their own.
declare module "@fontsource-variable/geist";
declare module "@fontsource-variable/geist-mono";
declare module "@fontsource-variable/newsreader";
