import "server-only";

import QRCode from "qrcode";

/** SVG markup of a QR code for one of our own tenant-link URLs. */
export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#183b30", light: "#ffffff" } });
}
