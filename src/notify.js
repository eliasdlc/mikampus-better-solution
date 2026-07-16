import { spawn } from 'node:child_process';

// notify-send ya está disponible en el entorno Hyprland/mako del usuario:
// notificación de escritorio inmediata, sin depender de un bot externo.
export function notify(title, body, { urgency = 'normal' } = {}) {
  const child = spawn('notify-send', ['-u', urgency, '-a', 'pucmm-autoenroll', title, body], {
    stdio: 'ignore',
  });
  child.on('error', () => {
    console.warn('[notify] notify-send no disponible, se omite notificación de escritorio');
  });
}
