// A tiny stand-in for the embedded vocabulary data (spec 12.2) used by the mock core: lemmas with their part of
// speech, a Zipf frequency, a few first-sense definitions, WordNet-like exception lists, derivation links, phrasal
// verbs and the function words. Enough for the mock books (mock/vocabCorpus.ts and mock.ts); the real data is built
// by scripts/build-wordnet.sh.
import type { VocabPos } from '../types';

export interface LexEntry {
  pos: VocabPos[];
  zipf: number;
  definition: string | null;
}

// "lemma pos zipf" per entry; pos letters n v a r (several allowed: "nv"). Zipf ≈ the wordfreq scale.
const RAW = `
able a 5.2|abandon v 4.3|ability n 4.8|about r 6.5|act nv 5.1|action n 5.3|after r 6.0|again r 5.8|all a 6.6|aloud r 3.6
ambush nv 2.9|animal n 5.2|apple n 4.7|appear v 5.0|arrive v 4.8|ask v 5.6|autumn n 4.4|away r 5.8|back nr 6.0|bad a 5.6
barn n 3.9|base nv 5.1|basic a 5.0|battle n 4.9|be v 7.3|beat v 4.9|become v 5.6|bed n 5.2|bedroom n 4.6|begin v 5.3
behind r 5.4|bitter a 4.2|blame v 4.6|boar n 2.6|book n 5.6|brain n 4.9|brown a 4.8|build v 5.4|building n 5.2|carry v 5.0
certainty n 3.9|chaff n 2.3|change nv 5.6|chapter n 4.7|child n 5.5|choose v 5.0|clever a 4.4|commandment n 2.6
cowshed n 1.8|creature n 4.4|crowd n 4.6|dark a 5.2|darkness n 4.4|dawn n 4.3|day n 6.1|dead a 5.4|deep a 5.1
defend v 4.6|delivery n 4.5|die v 5.4|dinner n 5.1|do v 6.9|dog n 5.3|donkey n 3.8|doubt nv 4.8|draw v 5.1
drawing n 4.5|dream n 5.1|drink v 5.2|drunk a 4.8|easy a 5.4|eat v 5.4|egg n 4.8|end nv 5.7|evening n 5.0
every a 6.2|explain v 5.0|expose v 4.3|face n 5.5|fade v 4.2|fall v 5.3|familiar a 4.6|farm n 4.9|farmhouse n 2.7
feel v 5.9|feeling n 5.2|few a 5.8|field n 5.2|fight nv 5.3|figure n 5.1|find v 5.9|first a 6.1|five a 5.6|floor n 5.1
flutter v 3.4|fox n 4.6|full a 5.4|future n 5.3|gate n 4.6|gather v 4.5|give v 6.0|good a 6.2|great a 5.9|grumble v 2.5
happy a 5.6|happiness n 4.4|hard a 5.6|hardship n 3.2|harrow n 2.2|harvest n 4.2|have v 7.0|hay n 3.8|hear v 5.8
heat n 4.9|heavy a 5.0|hedge n 3.8|hen n 3.9|hind a 3.0|hoof n 2.5|horse n 5.0|hour n 5.6|house n 5.7|interest nv 5.4
interesting a 5.2|item n 4.9|job n 5.6|jump v 4.9|kind a 5.4|kindness n 4.0|knock v 4.8|knoll n 2.3|know v 6.4
lad n 3.9|large a 5.3|last a 6.0|late a 5.6|later r 5.6|lazy a 4.5|lead v 5.2|leader n 5.0|learn v 5.3|learner n 3.6
learning n 4.7|leg n 4.9|lesson n 4.6|let v 6.0|life n 6.0|lift v 4.7|light n 5.4|like v 6.6|list n 5.1|listen v 5.4
little a 5.9|live v 5.7|lock v 4.7|long a 5.9|look v 6.0|lose v 5.5|major n 5.0|make v 6.3|man n 6.0|mangel n 1.5
manor n 3.4|mean v 5.9|meaning n 4.8|medal n 4.0|meet v 5.6|meeting n 5.0|message n 5.2|milk n 4.8|misery n 4.0
mix v 4.6|mud n 4.0|need v 6.0|new a 6.2|night n 5.8|node n 4.2|number n 5.6|often r 5.5|old a 6.0|order n 5.5
other a 6.3|page n 5.3|paint v 4.7|paddock n 2.6|part n 5.8|pass v 5.4|path n 4.9|peace n 5.2|peaceful a 4.3
peacefully r 3.6|pig n 4.6|plan n 5.4|pop n 4.7|process n 5.3|program n 5.4|prove v 5.0|publisher n 4.1|push v 5.0
quality n 5.1|quarry n 3.0|quick a 5.2|quickly r 5.1|quiet a 4.9|quietly r 4.2|ration n 2.6|read v 5.8|reader n 4.7
reading n 5.0|ready a 5.6|rebel n 4.2|rebellion n 3.8|record n 5.3|refuse v 4.9|regard v 4.6|reliable a 4.4
remember v 5.6|repeat v 4.8|respect n 5.0|retry v 2.9|review v 4.9|robot n 4.5|root n 4.6|routine n 4.4|rule n 5.2
run v 5.8|save v 5.5|say v 6.6|see v 6.5|seem v 5.8|send v 5.6|service n 5.5|session n 4.8|set v 5.7|shed n 3.9
short a 5.4|shout v 4.7|shut v 5.0|silence n 4.8|single a 5.3|six a 5.3|slave n 4.4|sleep nv 5.4|slow a 5.0
slowly r 4.8|small a 5.6|so r 6.8|society n 5.0|song n 5.4|soon r 5.7|sorry a 5.6|speak v 5.4|speed n 5.0|split v 4.6
spoil v 4.2|stable n 4.4|stalk n 2.7|steal v 5.0|stick n 4.7|stir v 3.9|stop v 5.9|storm n 4.7|strange a 5.0
strength n 4.9|strong a 5.3|study nv 5.4|subscriber n 4.0|success n 5.2|summer n 5.1|sun n 5.2|talk v 5.7|teach v 5.2
teaching n 4.6|teacher n 5.1|tell v 6.1|third a 5.2|three a 5.9|time n 6.4|topic n 4.8|try v 6.0|tune n 4.4|two a 6.2
unit n 5.0|unlearn v 2.8|van n 4.5|vocabulary n 4.1|walk v 5.6|wall n 5.2|want v 6.4|well r 6.3|window n 5.1
windmill n 2.4|winter n 5.0|word n 5.7|work nv 6.0|worker n 5.0|write v 5.7|year n 6.2|house n 5.7|kitchen n 4.9
garden n 5.0|door n 5.3|home n 5.9|speech n 5.0|walking n 4.4|mr n 5.7|hole n 4.8|everyone n 5.9
highly r 4.9|quite r 6.0|big a 6.0|nobody n 5.3|other na 6.3|go v 6.6|come v 6.4|tooth n 4.6|morning n 5.4
evening n 5.0|easy a 5.4|try v 6.0
`;

const DEFINITIONS: Record<string, string> = {
  windmill: 'A mill powered by the wind turning its sails.',
  knoll: 'A small natural hill.',
  harrow: 'A heavy frame with teeth, dragged over ploughed land to break up the soil.',
  paddock: 'A small field where horses are kept or exercised.',
  mangel: 'A beet with a large root, grown to feed cattle.',
  chaff: 'The husks of grain separated from the seed.',
  boar: 'An uncastrated male pig.',
  ambush: 'A surprise attack by people lying in wait in a hidden position.',
  cowshed: 'A barn for cows.',
  quarry: 'A place where stone is dug out of the ground.',
  hoof: 'The hard covering of the foot of a horse and similar animals.',
  learner: 'Someone who is learning a subject or skill.',
  learning: 'The knowledge or skill gained by study.',
  learn: 'Gain knowledge or skill by study or experience.',
  unlearn: 'Try to forget something learned, such as a habit or belief.',
  happiness: 'The state of being happy.',
  quickly: 'With speed; in a short time.',
  rebellion: 'An organized attempt to change a government or leader by force.',
  commandment: 'A rule given by an authority, especially a divine one.',
  ration: 'A fixed amount of food allowed to each person or animal.',
  grumble: 'Complain in a quiet, bad-tempered way.',
  stalk: 'The main stem of a plant.',
  misery: 'Great unhappiness.',
  harvest: 'The gathering of a ripe crop.',
  hedge: 'A fence of bushes or small trees.',
  slave: 'A person who is the legal property of another and is forced to obey them.',
  donkey: 'A domesticated animal of the horse family with long ears.',
  meaning: 'The idea that a word, sign or action expresses.',
  feeling: 'An emotional state or reaction.',
  building: 'A structure with a roof and walls.',
  interesting: 'Arousing curiosity or interest.',
  hardship: 'Severe suffering or lack of something needed.',
  medal: 'A metal disc given as an award.',
  creature: 'A living being, especially an animal.',
  farmhouse: 'The main house on a farm.',
};

function parse(): Map<string, LexEntry> {
  const out = new Map<string, LexEntry>();
  for (const raw of RAW.split(/[|\n]/)) {
    const [lemma, pos, zipf] = raw.trim().split(/\s+/);
    if (!lemma || !pos || !zipf) continue;
    out.set(lemma, {
      pos: [...pos].filter((p): p is VocabPos => 'nvar'.includes(p)),
      zipf: Number(zipf),
      definition: DEFINITIONS[lemma] ?? null,
    });
  }
  return out;
}

export const LEXICON: ReadonlyMap<string, LexEntry> = parse();

/** WordNet-style exception lists: irregular form → lemma (with the part of speech of the rule). */
export const EXCEPTIONS: Readonly<Record<string, string>> = {
  went: 'go',
  gone: 'go',
  ran: 'run',
  was: 'be',
  were: 'be',
  been: 'be',
  is: 'be',
  are: 'be',
  am: 'be',
  had: 'have',
  has: 'have',
  did: 'do',
  does: 'do',
  done: 'do',
  said: 'say',
  made: 'make',
  took: 'take',
  taken: 'take',
  came: 'come',
  saw: 'see',
  seen: 'see',
  knew: 'know',
  known: 'know',
  thought: 'think',
  told: 'tell',
  found: 'find',
  gave: 'give',
  given: 'give',
  got: 'get',
  began: 'begin',
  begun: 'begin',
  stood: 'stand',
  children: 'child',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  better: 'good',
  best: 'good',
  worse: 'bad',
  worst: 'bad',
  built: 'build',
  felt: 'feel',
  meant: 'mean',
  kept: 'keep',
  left: 'leave',
  slept: 'sleep',
  fought: 'fight',
  brought: 'bring',
  ate: 'eat',
  drank: 'drink',
  sang: 'sing',
  sung: 'sing',
  rose: 'rise',
  fell: 'fall',
  fallen: 'fall',
  led: 'lead',
  held: 'hold',
  heard: 'hear',
  sat: 'sit',
  hid: 'hide',
  broke: 'break',
  broken: 'break',
  spoke: 'speak',
  spoken: 'speak',
  wrote: 'write',
  written: 'write',
  drove: 'drive',
  rode: 'ride',
  threw: 'throw',
  grew: 'grow',
  flew: 'fly',
  understood: 'understand',
  taught: 'teach',
  caught: 'catch',
  sold: 'sell',
  paid: 'pay',
  lost: 'lose',
  won: 'win',
  struck: 'strike',
  shook: 'shake',
  woke: 'wake',
  wore: 'wear',
  stole: 'steal',
  stolen: 'steal',
  forgot: 'forget',
  chose: 'choose',
  froze: 'freeze',
  sent: 'send',
  spent: 'spend',
  drew: 'draw',
  drawn: 'draw',
  lay: 'lie',
  hooves: 'hoof',
  lives: 'life',
  knives: 'knife',
  leaves: 'leaf',
  wolves: 'wolf',
  shelves: 'shelf',
  cleverest: 'clever',
  tried: 'try',
  studied: 'study',
  easier: 'easy',
  easiest: 'easy',
  carried: 'carry',
  worried: 'worry',
  cried: 'cry',
};

/** Derivation links of WordNet (derived lemma → base lemma), spec 12.3 I. */
export const DERIVATIONS: Readonly<Record<string, string>> = {
  learner: 'learn',
  unlearn: 'learn',
  happiness: 'happy',
  quickly: 'quick',
  slowly: 'slow',
  quietly: 'quiet',
  peaceful: 'peace',
  peacefully: 'peaceful',
  rebellion: 'rebel',
  darkness: 'dark',
  kindness: 'kind',
  strength: 'strong',
  teacher: 'teach',
  leader: 'lead',
  worker: 'work',
  reader: 'read',
  publisher: 'publish',
  subscriber: 'subscribe',
};

/** Phrasal verbs of the lexicon (spec 12.3 H). */
export const PHRASAL_VERBS: ReadonlySet<string> = new Set([
  'set up',
  'give in',
  'give up',
  'look up',
  'find out',
  'carry out',
  'go on',
  'come back',
  'walk out',
  'knock down',
  'read out',
  'go down',
]);

export const PARTICLES: ReadonlySet<string> = new Set(['up', 'in', 'out', 'on', 'back', 'down', 'off', 'away', 'over']);

/** English function words (stopwords) counted as known by default. */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but
  by can could did do does doing down during each few for from further had has have having he her here hers herself
  him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or
  other our ours ourselves out over own same she should so some such than that the their theirs them themselves then
  there these they this those through to too under until up very was we were what when where which while who whom why
  will with would you your yours yourself yourselves also every ever never though besides across around behind near
  upon still yet much many mr mrs one`
    .split(/\s+/)
    .filter(Boolean),
);
