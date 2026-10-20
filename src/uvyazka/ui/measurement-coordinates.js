// Render metadata refers to the actual raster origin, including cropped pixel rounding.
export function pagePoint(clientX, clientY, rect, metadata) {
  if (!(rect.width > 0 && rect.height > 0)) throw Error('Лист ещё не отображён.');
  return [
    (clientX - rect.left) / rect.width * metadata.pixel_size[0] / metadata.pixels_per_point + metadata.pixel_origin_page_points[0],
    (clientY - rect.top) / rect.height * metadata.pixel_size[1] / metadata.pixels_per_point + metadata.pixel_origin_page_points[1],
  ];
}
export function imagePoint(point, metadata) {
  return point.map((v, i) => (v - metadata.pixel_origin_page_points[i]) * metadata.pixels_per_point);
}
export function parsePoints(value) {
  const rows = value.trim().split(/\r?\n/).filter(r => r.trim());
  if (rows.length > 500) throw Error('Не более 500 точек.');
  return rows.map(row => {
    const numbers = row.trim().split(/[,;\s]+/);
    if (numbers.length !== 2 || numbers.some(n => !n || !Number.isFinite(Number(n)))) throw Error('Нужны две координаты в каждой строке: x, y. Дробная часть — через точку.');
    return numbers.map(Number);
  });
}
