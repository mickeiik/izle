# Sample catalog notice

This directory is an izle catalog bundle (`bundle.json`, `items.json`, `assets/`). It contains **metadata and
links only**: no video is stored in this repository. The media URLs point to copies hosted by third parties
(archive.org, the Blender Foundation, and public demo CDNs operated by Unified Streaming, Mux, Akamai and
Google for the Shaka Player project). Those services belong to their operators, may change or disappear at any
time, and are used here only as freely reachable copies of openly licensed works. Run `npm run sample:check` to
see which links still answer.

Synopses in `items.json` were written for this catalog. Posters in `assets/` are re-encoded (resized/cropped
to 400×600 JPEG) from the sources below by `build.mjs`; file names are the SHA-256 of their content.

## Works

| Item | Work | Author / rights holder | License | Media hosted by |
|---|---|---|---|---|
| `tears-of-steel` | *Tears of Steel* (2012) | Blender Foundation (Project Mango) — mango.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Unified Streaming demo (`demo.unified-streaming.com`), Mux test streams (`test-streams.mux.dev`) |
| `big-buck-bunny` | *Big Buck Bunny* (2008) | Blender Foundation (Peach Open Movie Project) — peach.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Mux test streams (`test-streams.mux.dev`), Akamai DASH demo (`dash.akamaized.net`) |
| `sintel` | *Sintel* (2010) | Blender Foundation (Durian Open Movie Project) — durian.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Shaka Player demo assets (`storage.googleapis.com/shaka-demo-assets`), Internet Archive (`archive.org/details/Sintel`) |
| `elephants-dream` | *Elephants Dream* (2006) | Orange Open Movie Project (Blender Foundation / Netherlands Media Art Institute) — orange.blender.org | [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/) (the Internet Archive item lists CC BY 3.0 US) | Internet Archive (`archive.org/details/ElephantsDream`), Blender Foundation (`download.blender.org/ED/`) |
| `caminandes` s01e01 | *Caminandes 1: Llama Drama* (2013) | Pablo Vázquez, Beorn Leonard, Francesco Siddi / Blender Institute — caminandes.com | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Internet Archive (`archive.org/details/Caminandes1LlamaDrama`) |
| `caminandes` s01e02 | *Caminandes 2: Gran Dillama* (2013) | Pablo Vázquez, Beorn Leonard, Francesco Siddi / Blender Institute — caminandes.com | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Internet Archive (`archive.org/details/Caminandes2GranDillama`) |
| `caminandes` s01e03 | *Caminandes 3: Llamigos* (2016) | Pablo Vázquez / Blender Institute — caminandes.com | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) (as listed by the Internet Archive item) | Internet Archive (`archive.org/details/CaminandesLlamigos`) |
| `his-girl-friday` | *His Girl Friday* (1940), dir. Howard Hawks | Columbia Pictures (copyright not renewed) | Public domain in the United States ([archive.org](https://archive.org/details/his_girl_friday) lists it as public domain) | Internet Archive (`archive.org/details/his_girl_friday`) |

## Posters

| Item | Source | Author | License |
|---|---|---|---|
| `tears-of-steel` | [File:Tos-poster.png](https://commons.wikimedia.org/wiki/File:Tos-poster.png) (Wikimedia Commons) | Blender Foundation / Project Mango | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `big-buck-bunny` | [File:Big buck bunny poster big.jpg](https://commons.wikimedia.org/wiki/File:Big_buck_bunny_poster_big.jpg) (Wikimedia Commons) | Blender Foundation / peach.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `sintel` | [File:Sintel poster.jpg](https://commons.wikimedia.org/wiki/File:Sintel_poster.jpg) (Wikimedia Commons) | Blender Foundation / durian.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `elephants-dream` | [File:Elephants Dream s5 both.jpg](https://commons.wikimedia.org/wiki/File:Elephants_Dream_s5_both.jpg) (Wikimedia Commons), cropped | Ton Roosendaal et al. (Orange Open Movie Project) | [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/) |
| `caminandes` | [File:Caminandes gran dillama.png](https://commons.wikimedia.org/wiki/File:Caminandes_gran_dillama.png) (Wikimedia Commons), cropped | Francesco Siddi, Pablo Vázquez | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `his-girl-friday` | [File:His Girl Friday (1940 poster).jpg](https://commons.wikimedia.org/wiki/File:His_Girl_Friday_(1940_poster).jpg) (Wikimedia Commons) | Columbia Pictures | Public domain (Wikimedia Commons) |

Changes made to the posters: scaled and cropped to a 2:3 frame and re-encoded as JPEG. No endorsement by the
authors or rights holders is implied.
