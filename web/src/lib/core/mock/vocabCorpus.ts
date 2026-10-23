// Text of the mock "Animal Farm" book (original sentences written for the tests, not the novel's text): ten chapters
// of six pages, so the vocabulary scan has chapters, ranges, inflections, derivatives, phrasal verbs, rare words and
// proper nouns to find (spec 12.3). Used by mock.ts (page text, outline) and mock/vocab.ts.
import type { PdfOutlineItem } from '../../pdf/minimalPdf';

export const FARM_PAGES_PER_CHAPTER = 6;
export const FARM_CHAPTERS = 10;
export const FARM_PAGES = FARM_PAGES_PER_CHAPTER * FARM_CHAPTERS;

/** Paragraphs of each chapter; page k of a chapter shows two of them, rotating. */
export const FARM_CHAPTER_TEXT: readonly (readonly string[])[] = [
  [
    'The animals gathered in the big barn after dark, because Old Major wanted to tell them about a strange dream.',
    'He said that the life of an animal is short and full of misery, and that no animal in England knows the meaning of happiness.',
    'Every creature on the farm listened quickly and quietly while the old boar spoke of a better future.',
  ],
  [
    'Three nights later Old Major died peacefully in his sleep, and the cleverest pigs began the work of teaching the others.',
    'In the barn, Snowball and Napoleon set up meetings where the learning of the animals went on until late at night.',
    'Boxer was a slow learner, but he repeated every lesson with a feeling of deep respect for the pigs.',
  ],
  [
    'The hay harvest was a great success, and the animals worked quickly in the fields from dawn until the sun went down.',
    'Boxer pushed the heavy harrow across the paddock while Clover gathered the fallen stalks with her strong teeth.',
    'Nobody stole and nobody grumbled, and the happiness of the first summer seemed to have no end.',
  ],
  [
    'In the autumn a crowd of men came through the gate with sticks, and the animals had to defend the farm buildings.',
    'Snowball had studied old books about battles, and he set up an ambush behind the hedge near the cowshed.',
    'After the fight the animals gave a medal to Boxer, who felt sorry for a stable lad he had knocked into the mud.',
  ],
  [
    'Snowball drew the plans of a windmill on the floor of a shed, and the animals came every day to look at the drawings.',
    'The windmill would give them light and heat, and the building of it would make the work of the farm much easier.',
    'Napoleon walked around the plans in silence, then lifted his leg and spoiled them before he walked out.',
  ],
  [
    'All that year the animals worked like slaves, and the building of the windmill on the knoll went on slowly.',
    'Every morning Squealer explained that the pigs needed the apples and the milk, because their brain work was so interesting and so hard.',
    'Benjamin the donkey refused to give in, saying only that donkeys live a long time and nobody has ever seen a dead donkey.',
  ],
  [
    'A bitter winter came, and the animals had little to eat besides chaff and the last of the mangel roots.',
    'The hens would not give up their eggs, so Napoleon stopped their rations until they gave in after five days.',
    'Squealer read out long lists of figures that proved the meaning of every hardship, and the animals tried to unlearn their doubts.',
  ],
  [
    'Napoleon now lived in the farmhouse and slept in a bed, and the rules painted on the wall of the barn seemed to change at night.',
    'Clover asked Benjamin to read the commandments aloud, and the old donkey looked up at the wall for a long time.',
    'A storm in November knocked down the windmill, and Napoleon found out quickly whom he wanted to blame for it.',
  ],
  [
    'Boxer worked harder than ever on the new windmill, though his hoof was split and his feeling of strength was fading.',
    'One evening he fell on the path to the quarry, and the pigs carried out a plan to send him away in a van.',
    'The animals ran after the van shouting, but the horse never came back, and his learning had not saved him.',
  ],
  [
    'Years passed, and only a few old animals remembered the days before the rebellion and the meaning of the old song.',
    'The pigs began to walk on their hind legs, and the men from Pilkington came to dinner in the farmhouse.',
    'Looking through the window, the animals could no longer tell which faces were the pigs and which were the men.',
  ],
];

/** The outline written into the mock book's PDF: "Cap N" items, a nested part and an item without a page. */
export function farmOutline(): PdfOutlineItem[] {
  const items: PdfOutlineItem[] = Array.from({ length: FARM_CHAPTERS }, (_, c) => ({
    title: `Cap ${c + 1}`,
    page: c * FARM_PAGES_PER_CHAPTER,
  }));
  items[1]!.children = [
    { title: 'A morte do Major', page: FARM_PAGES_PER_CHAPTER },
    { title: 'As reuniões no celeiro', page: FARM_PAGES_PER_CHAPTER + 3 },
  ];
  items.push({ title: 'Notas do editor' });
  return items;
}

/** Two chapter paragraphs for page `i` (0-based) of the book. */
export function farmChapterParagraphs(i: number): string[] {
  const chapter = Math.min(FARM_CHAPTERS - 1, Math.floor(i / FARM_PAGES_PER_CHAPTER));
  const paras = FARM_CHAPTER_TEXT[chapter]!;
  const k = i % FARM_PAGES_PER_CHAPTER;
  return [paras[k % paras.length]!, paras[(k + 1) % paras.length]!];
}
