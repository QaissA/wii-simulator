/**
 * QR rendering for the pairing screen.
 *
 * `layer-3-display-engine.md` §Latency & feel: "this screen renders the QR the
 * phone scans."
 *
 * Error-correction level M, not H. H survives more damage, but the extra
 * redundancy makes each module smaller for a given canvas size, and the failure
 * mode here is not a torn sticker — it is a phone camera reading a bright screen
 * from two metres away. Bigger modules beat more redundancy for that.
 */

import QRCode from 'qrcode';

export interface QrOptions {
  /** Canvas edge length, CSS pixels. */
  size?: number;
}

/**
 * Draw `text` as a QR onto a fresh canvas.
 *
 * Rendered light-on-dark inverted — i.e. dark modules on a *white* field even
 * though the page is dark. Scanners expect that polarity, and while many cope
 * with inversion, "many" is not a property to rely on when the alternative is a
 * white rounded card behind the code.
 */
export async function renderQr(text: string, options: QrOptions = {}): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  const size = options.size ?? 320;
  await QRCode.toCanvas(canvas, text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b0f16ff', light: '#ffffffff' },
  });
  canvas.className = 'qr';
  return canvas;
}
