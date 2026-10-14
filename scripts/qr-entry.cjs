// Only the QR encoder and PNG renderer are bundled, never the qrcode CLI.
const QRCode = require('qrcode/lib/core/qrcode');
const PNG = require('qrcode/lib/renderer/png');

exports.toDataURL = async (text, options = {}) => {
  const data = QRCode.create(text, options);
  return new Promise((resolve, reject) => {
    PNG.renderToBuffer(data, options, (error, buffer) => {
      if (error) reject(error);
      else resolve(`data:image/png;base64,${buffer.toString('base64')}`);
    });
  });
};
