// Turns a chosen picture into a small square JPEG "data:" link that can be stored in the database like any other text.
export async function photoToDataUrl(file, max = 28000) {
  const bmp = await (window.createImageBitmap ? createImageBitmap(file) : new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }));
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight, side = Math.min(w, h);
  for (const [px, q] of [[256, .8], [256, .65], [192, .6], [160, .5], [128, .45], [96, .4]]) {
    const c = document.createElement("canvas"); c.width = c.height = px;
    c.getContext("2d").drawImage(bmp, (w - side) / 2, (h - side) / 2, side, side, 0, 0, px, px);
    const out = c.toDataURL("image/jpeg", q);
    if (out.length <= max) return out;
  }
  throw new Error("too big");
}
/** Wires a button + hidden file input: on choosing an image, calls onData(dataUrl). */
export function wirePhotoUpload(button, fileInput, onData, onError) {
  button.onclick = () => fileInput.click();
  fileInput.onchange = async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    if (!/^image\//.test(f.type)) return onError("Choose an image file.");
    try { onData(await photoToDataUrl(f)); } catch (_) { onError("Couldn't use that photo. Try a different one."); }
  };
}
