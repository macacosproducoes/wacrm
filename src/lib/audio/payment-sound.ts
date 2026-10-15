/**
 * Payment Sound Notification Utility
 * Plays "dinheiro-caindo-na-conta.mp3" when a payment is received in the CRM panel.
 */

let paymentAudioInstance: HTMLAudioElement | null = null;
let lastPlayedAt = 0;
const THROTTLE_MS = 3000;

export function getPaymentAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!paymentAudioInstance) {
    try {
      paymentAudioInstance = new Audio('/audio/dinheiro-caindo-na-conta.mp3');
      paymentAudioInstance.preload = 'auto';
      paymentAudioInstance.volume = 1.0;
    } catch (err) {
      console.warn('[PaymentSound] Could not create Audio element:', err);
    }
  }
  return paymentAudioInstance;
}

/**
 * Unlocks audio autoplay on the first user interaction (click, keypress, touch)
 * required by modern browser autoplay policies.
 */
export function unlockAudioOnFirstInteraction(): () => void {
  if (typeof window === 'undefined') return () => {};

  const unlock = () => {
    try {
      const audio = getPaymentAudio();
      if (audio) {
        audio.volume = 0.01;
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              audio.pause();
              audio.currentTime = 0;
              audio.volume = 1.0;
            })
            .catch(() => {});
        }
      }
    } catch {}
    window.removeEventListener('click', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  };

  window.addEventListener('click', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });
  window.addEventListener('touchstart', unlock, { once: true, passive: true });

  return () => {
    window.removeEventListener('click', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
}

/**
 * Plays the "dinheiro-caindo-na-conta.mp3" notification sound.
 * Throttled to prevent overlapping sounds if multiple events arrive simultaneously.
 */
export function playPaymentNotificationSound(force = false): boolean {
  if (typeof window === 'undefined') return false;

  const now = Date.now();
  if (!force && now - lastPlayedAt < THROTTLE_MS) {
    return false;
  }

  const audio = getPaymentAudio();
  if (!audio) return false;

  try {
    audio.currentTime = 0;
    audio.volume = 1.0;
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          lastPlayedAt = Date.now();
        })
        .catch((err: unknown) => {
          console.warn('[PaymentSound] Autoplay was prevented by browser policy:', err);
          // Try fallback relative path if /audio/ failed
          if (audio.src && audio.src.includes('/audio/')) {
            audio.src = '/dinheiro-caindo-na-conta.mp3';
            audio.play().catch(() => {});
          }
        });
    }
    return true;
  } catch (err) {
    console.warn('[PaymentSound] Error playing payment sound:', err);
    return false;
  }
}
