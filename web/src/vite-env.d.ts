/// <reference types="vite/client" />

// Los paquetes de Fontsource variable se importan por su entrada (sin
// extensión .css), así que TS necesita una declaración de módulo para ellos.
declare module '@fontsource-variable/*';
