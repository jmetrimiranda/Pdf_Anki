import { describe, expect, it } from 'vitest';
import { parseLeitorLink } from '../anki/study/links';
import { escapeHtml, fonteHtml, fonteHtmlSection, fonteQuery, sectionLabel } from './fonte';

const UID = 'a'.repeat(64);

describe('fonteHtml', () => {
  it('writes the exact literal shared with the core', () => {
    expect(fonteHtml(UID, 'Animal Farm', 37, 'the windmill')).toBe(
      `<a href="leitor://livro/${UID}?pagina=37&amp;q=the%20windmill">Animal Farm, p. 37</a>`,
    );
  });

  it('escapes the title and percent-encodes the query', () => {
    expect(fonteHtml(UID, 'Tom & <Jerry> "2"', 2, 'a&b <c> "d" ção')).toBe(
      `<a href="leitor://livro/${UID}?pagina=2&amp;q=a%26b%20%3Cc%3E%20%22d%22%20%C3%A7%C3%A3o">Tom &amp; &lt;Jerry&gt; &quot;2&quot;, p. 2</a>`,
    );
  });

  it('matches the core literals (core-anki study::source::tests::source_html_literal)', () => {
    expect(fonteHtml(UID, 'Tom & "Jerry" <1>', 2, 'a&b=c?d#e+f/g')).toBe(
      `<a href="leitor://livro/${UID}?pagina=2&amp;q=a%26b%3Dc%3Fd%23e%2Bf%2Fg">Tom &amp; &quot;Jerry&quot; &lt;1&gt;, p. 2</a>`,
    );
    expect(fonteHtml(UID, 'x', 3, "it's (fine)! ~*_.-")).toMatch(/q=it's%20\(fine\)!%20~\*_\.-">x, p\. 3<\/a>$/);
    expect(fonteHtml(UID, 'x', 3, 'é ç')).toContain('q=%C3%A9%20%C3%A7"');
  });

  it('leaves q out when the query is empty', () => {
    expect(fonteHtml(UID, 'Livro', 1, '')).toBe(`<a href="leitor://livro/${UID}?pagina=1">Livro, p. 1</a>`);
  });

  it('round-trips through the study screen link parser', () => {
    const query = fonteQuery('“Four legs good,\n two legs   bad!” & more');
    const html = fonteHtml(UID, 'Animal Farm', 12, query);
    const href = /href="([^"]+)"/.exec(html)![1]!;
    expect(parseLeitorLink(href, 'Animal Farm, p. 12')).toEqual({
      bookUid: UID,
      page: 12,
      unit: 'page',
      cfi: null,
      query: '“Four legs good, two legs bad!” & more',
      label: 'Animal Farm, p. 12',
    });
    expect(parseLeitorLink(/href="([^"]+)"/.exec(fonteHtml(UID, 'X', 3, ''))![1]!)?.query).toBeNull();
  });
});

describe('fonteHtmlSection (EPUB, spec 7.1)', () => {
  it('matches the core literals (core-anki study::source::tests::source_html_section_literal)', () => {
    expect(fonteHtmlSection(UID, 'Animal Farm', 3, 'Chapter III', 'epubcfi(/6/8!/4/2/1:0)', 'the windmill')).toBe(
      `<a href="leitor://livro/${UID}?cap=3&amp;cfi=epubcfi(%2F6%2F8!%2F4%2F2%2F1%3A0)&amp;q=the%20windmill">Animal Farm, Chapter III</a>`,
    );
    expect(fonteHtmlSection(UID, 'Animal Farm', 1, '', null, '')).toBe(
      `<a href="leitor://livro/${UID}?cap=1">Animal Farm, cap. 1</a>`,
    );
    expect(fonteHtmlSection(UID, 'Animal Farm', 2, '  \n ', '', 'pigs')).toBe(
      `<a href="leitor://livro/${UID}?cap=2&amp;q=pigs">Animal Farm, cap. 2</a>`,
    );
    expect(
      fonteHtmlSection(
        UID,
        'Tom & "Jerry"',
        12,
        'Part One: The Rebellion & the Windmill of Animal Farm, in which everything changes',
        'epubcfi(/6/4!/4/2,/1:0,/1:12)',
        '',
      ),
    ).toBe(
      `<a href="leitor://livro/${UID}?cap=12&amp;cfi=epubcfi(%2F6%2F4!%2F4%2F2%2C%2F1%3A0%2C%2F1%3A12)">Tom &amp; &quot;Jerry&quot;, Part One: The Rebellion &amp; the Windmill of Animal Farm, in</a>`,
    );
    expect(sectionLabel('<b>Intro</b>', 4)).toBe('<b>Intro</b>');
    expect(sectionLabel('', 4)).toBe('cap. 4');
    expect(sectionLabel(null, 4)).toBe('cap. 4');
    expect(sectionLabel('x'.repeat(70), 4)).toBe('x'.repeat(60));
  });

  it('round-trips through the study screen link parser (core-anki chapter_links_parse)', () => {
    const html = fonteHtmlSection(UID, 'Animal Farm', 3, 'Chapter III', 'epubcfi(/6/8!/4/2/1:0)', 'the windmill');
    const href = /href="([^"]+)"/.exec(html)![1]!;
    expect(parseLeitorLink(href, 'Animal Farm, Chapter III')).toEqual({
      bookUid: UID,
      page: 3,
      unit: 'chapter',
      cfi: 'epubcfi(/6/8!/4/2/1:0)',
      query: 'the windmill',
      label: 'Animal Farm, Chapter III',
    });
  });
});

describe('fonteQuery', () => {
  it('collapses whitespace and trims', () => {
    expect(fonteQuery('  the\n\twindmill  was\r\nbuilt ')).toBe('the windmill was built');
    expect(fonteQuery(' \n ')).toBe('');
  });

  it('cuts at a word boundary to at most 80 characters', () => {
    const words = 'All animals are equal but some animals are more equal than others said the pigs one day';
    expect(words.length).toBeGreaterThan(80);
    const q = fonteQuery(words);
    expect(q.length).toBeLessThanOrEqual(80);
    expect(words.startsWith(q)).toBe(true);
    expect(words[q.length]).toBe(' ');
    expect(q).toBe('All animals are equal but some animals are more equal than others said the pigs');
  });

  it('keeps exactly 80 characters when the 81st is a space', () => {
    const eighty = `${'abcd '.repeat(15)}abcde`;
    expect(eighty.length).toBe(80);
    expect(fonteQuery(`${eighty} tail`)).toBe(eighty);
  });

  it('hard-cuts a single word longer than 80 characters', () => {
    expect(fonteQuery('x'.repeat(100))).toBe('x'.repeat(80));
  });
});

describe('escapeHtml', () => {
  it('escapes the HTML specials', () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; 'b'&lt;/b&gt;");
  });
});
