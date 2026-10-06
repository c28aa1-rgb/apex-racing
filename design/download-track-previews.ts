// Save the authors' Sketchfab thumbnails locally, so menus never contact Sketchfab or load a course.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TRACKS } from '../shared/tracks';
const credits = await readFile('public/models/tracks/CREDITS.txt', 'utf8');
const sources = [...credits.matchAll(/^Source: (https:\/\/sketchfab\.com\/3d-models\/[^\n]+)/gm)].map(match => match[1]);
if (sources.length !== TRACKS.length) throw new Error('Each track must have a credited Sketchfab source.');
await mkdir('public/art/tracks', { recursive: true });
await Promise.all(TRACKS.map(async (track, index) => {
  const id = sources[index].split('-').at(-1)!;
  const response = await fetch(`https://api.sketchfab.com/v3/models/${id}`);
  if (!response.ok) throw new Error(`Sketchfab metadata unavailable for ${track.name}.`);
  const model = await response.json() as { thumbnails: { images: { width: number; url: string }[] }; license: { slug: string } };
  if (model.license.slug !== 'by') throw new Error(`Review the image license for ${track.name}.`);
  const image = model.thumbnails.images.filter(image => image.width <= 1920).sort((a, b) => b.width - a.width)[0];
  if (!image) throw new Error(`No preview for ${track.name}.`);
  const photo = await fetch(image.url);
  if (!photo.ok) throw new Error(`Preview unavailable for ${track.name}.`);
  await writeFile(`public/art/tracks/${track.id}.jpg`, new Uint8Array(await photo.arrayBuffer()));
  console.log(`${track.id}: ${image.width}px`);
}));
await writeFile('public/art/tracks/CREDITS.txt', `Track preview images\n\nOriginal saved Sketchfab thumbnails, reproduced without image edits under CC BY 4.0.\nThe home page may crop images to fit the display and applies a separate readability overlay.\n\n${credits}`);
