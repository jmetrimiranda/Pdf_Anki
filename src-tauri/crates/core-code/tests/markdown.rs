//! The Markdown batch importer (spec 11.7): the spec's own example, one test per rule and error,
//! and a no-panic fuzz.

use core_code::markdown::{ItemKind, MAX_ITEMS, ProgramMode, parse};

const EXAMPLE: &str = include_str!("fixtures/import_example.md");

fn field<'a>(item: &'a core_code::ImportItem, name: &str) -> Option<&'a str> {
    item.fields.get(name).map(String::as_str)
}

#[test]
fn spec_example_imports_exactly() {
    let p = parse(EXAMPLE);
    assert!(p.errors.is_empty() && p.warnings.is_empty(), "{p:?}");
    assert_eq!(p.items.len(), 2);

    let a = &p.items[0];
    assert!(a.errors.is_empty() && a.warnings.is_empty(), "{a:?}");
    assert_eq!((a.index, a.line), (0, 1));
    assert_eq!(a.kind, Some(ItemKind::Command));
    assert_eq!(a.language.as_deref(), Some("bash"));
    assert_eq!(a.mode, None);
    assert_eq!(
        a.title,
        "Ver a transformação entre os frames world e turtle1"
    );
    assert_eq!(field(a, "Pergunta"), Some(a.title.as_str()));
    assert_eq!(
        field(a, "Resposta"),
        Some("ros2 run tf2_ros tf2_echo world turtle1")
    );
    assert_eq!(
        field(a, "Observação"),
        Some("Imprime Translation e Rotation (quaternion) a cada atualização.")
    );
    assert_eq!(
        field(a, "Aceitas"),
        Some("ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco")
    );
    assert_eq!(field(a, "Exige"), None);
    assert_eq!(a.tags, ["ros2", "tf2"]);
    assert_eq!(a.fields.len(), 4);

    let b = &p.items[1];
    assert!(b.errors.is_empty() && b.warnings.is_empty(), "{b:?}");
    assert_eq!((b.index, b.line), (1, 9));
    assert_eq!(b.kind, Some(ItemKind::Program));
    assert_eq!(b.language.as_deref(), Some("python"));
    assert_eq!(b.mode, Some(ProgramMode::Testes));
    assert_eq!(b.title, "Função que soma os pares de uma lista");
    assert_eq!(
        field(b, "Resposta"),
        Some("def soma_pares(xs):\n    return sum(x for x in xs if x % 2 == 0)")
    );
    assert_eq!(
        field(b, "Testes"),
        Some("assert soma_pares([1, 2, 3, 4]) == 6\nassert soma_pares([]) == 0")
    );
    assert_eq!(field(b, "Linguagem"), Some("python"));
    assert_eq!(field(b, "Modo"), Some("testes"));
    assert_eq!(field(b, "Observação"), None);
    assert_eq!(b.tags, ["python"]);
}

#[test]
fn indented_crlf_and_tilde_copies_of_the_example_import_the_same() {
    let reference = parse(EXAMPLE);
    let indented: String = EXAMPLE
        .lines()
        .map(|l| {
            if l.is_empty() {
                "\n".to_owned()
            } else {
                format!("  {l}\n")
            }
        })
        .collect();
    assert_eq!(parse(&indented), reference);
    assert_eq!(parse(&EXAMPLE.replace('\n', "\r\n")), reference);
    let tilde = EXAMPLE.replace("```", "~~~");
    assert_eq!(parse(&tilde), reference);
    assert_eq!(parse(&format!("\u{feff}{EXAMPLE}")), reference);
}

#[test]
fn preview_serializes_camel_case() {
    let json = serde_json::to_value(parse(EXAMPLE)).unwrap();
    let item = &json["items"][1];
    assert_eq!(item["kind"], "program");
    assert_eq!(item["mode"], "testes");
    assert_eq!(item["fields"]["SaidaEsperada"], serde_json::Value::Null);
    assert!(json["warnings"].as_array().unwrap().is_empty());
    assert_eq!(json["items"][0]["mode"], serde_json::Value::Null);
}

fn one(md: &str) -> core_code::ImportItem {
    let p = parse(md);
    assert_eq!(p.items.len(), 1, "{p:?}");
    p.items.into_iter().next().unwrap()
}

fn has_error(item: &core_code::ImportItem, needle: &str) -> bool {
    item.errors.iter().any(|e| e.contains(needle))
}

#[test]
fn languages_choose_the_kind() {
    for (lang, kind, language) in [
        ("bash", ItemKind::Command, "bash"),
        ("sh", ItemKind::Command, "sh"),
        ("ros2", ItemKind::Command, "ros2"),
        ("BASH", ItemKind::Command, "bash"),
        ("python", ItemKind::Program, "python"),
        ("cpp", ItemKind::Program, "cpp"),
        ("c++", ItemKind::Program, "cpp"),
    ] {
        let it = one(&format!("### Q\n```{lang}\nx\n```\n"));
        assert!(it.errors.is_empty(), "{lang}: {it:?}");
        assert_eq!(it.kind, Some(kind), "{lang}");
        assert_eq!(it.language.as_deref(), Some(language));
    }
}

#[test]
fn unknown_or_missing_language_is_an_error() {
    let it = one("### Q\n```rust\nfn main() {}\n```\n");
    assert_eq!(it.kind, None);
    assert!(
        has_error(&it, "Linguagem do bloco desconhecida: rust"),
        "{it:?}"
    );
    let it = one("### Q\n```\nls\n```\n");
    assert!(has_error(&it, "Linguagem do bloco desconhecida"), "{it:?}");
}

#[test]
fn modes_from_the_blocks_after_the_answer() {
    let it =
        one("### Q\n```python\nprint(input())\n```\n```input\nabc\n```\n```output\nabc\n```\n");
    assert!(it.errors.is_empty(), "{it:?}");
    assert_eq!(it.mode, Some(ProgramMode::Saida));
    assert_eq!(field(&it, "Entrada"), Some("abc"));
    assert_eq!(field(&it, "SaidaEsperada"), Some("abc"));
    assert_eq!(field(&it, "Modo"), Some("saida"));

    let it = one("### Q\n```cpp\nint main(){}\n```\n```output\nOlá\n```\n");
    assert_eq!(it.mode, Some(ProgramMode::Saida));
    assert_eq!(field(&it, "Entrada"), None);

    let it = one("### Q\n```python\nimport rclpy\n```\n");
    assert_eq!(it.mode, Some(ProgramMode::Estrutura));
    assert_eq!(field(&it, "Modo"), Some("estrutura"));

    let it = one(
        "### Q\n```python\ndef f(): return 1\n```\n```setup\nimport math\n```\n```start\ndef f():\n    pass\n```\n```tests\nassert f() == 1\n```\n",
    );
    assert!(it.errors.is_empty(), "{it:?}");
    assert_eq!(it.mode, Some(ProgramMode::Testes));
    assert_eq!(field(&it, "Setup"), Some("import math"));
    assert_eq!(field(&it, "Inicial"), Some("def f():\n    pass"));
}

#[test]
fn blockquote_is_the_notes() {
    let it = one("### Q\n```bash\nls\n```\n> linha 1\n>linha 2\n> \n");
    assert_eq!(field(&it, "Observação"), Some("linha 1\nlinha 2"));
}

#[test]
fn keys_are_optional_and_case_insensitive() {
    let it = one(
        "### Q\n```bash\nsudo apt install x\n```\nACEITAS:  sudo apt-get install x \nAceitas: sudo apt install -y x\nExige: sudo\nTags: a b\ntags: b c\n",
    );
    assert!(it.errors.is_empty() && it.warnings.is_empty(), "{it:?}");
    assert_eq!(
        field(&it, "Aceitas"),
        Some("sudo apt-get install x\nsudo apt install -y x")
    );
    assert_eq!(field(&it, "Exige"), Some("sudo"));
    assert_eq!(it.tags, ["a", "b", "c"]);
    let it = one("### Q\n```bash\nls\n```\n");
    assert!(it.tags.is_empty());
    assert_eq!(field(&it, "Aceitas"), None);
}

#[test]
fn error_no_fenced_block() {
    let it = one("### Q\naceitas: ls\n");
    assert!(has_error(&it, "Falta o bloco de código"), "{it:?}");
}

#[test]
fn error_unclosed_fence_keeps_the_next_items() {
    let p = parse("### A\n```bash\nls -la\n\n### B\n```bash\npwd\n```\n");
    assert_eq!(p.items.len(), 2, "{p:?}");
    assert!(
        p.items[0]
            .errors
            .iter()
            .any(|e| e.contains("sem fechamento"))
    );
    assert_eq!(field(&p.items[0], "Resposta"), Some("ls -la"));
    assert!(p.items[1].errors.is_empty(), "{:?}", p.items[1]);
    // A `###` inside a closed fence is code, not a heading.
    let it = one("### A\n```python\n### comment\nx = 1\n```\n");
    assert!(it.errors.is_empty());
    assert_eq!(field(&it, "Resposta"), Some("### comment\nx = 1"));
}

#[test]
fn error_program_blocks_on_a_command() {
    for block in ["tests", "output", "input", "setup", "start"] {
        let it = one(&format!("### Q\n```bash\nls\n```\n```{block}\nx\n```\n"));
        assert!(
            has_error(&it, "só valem para Python e C++"),
            "{block}: {it:?}"
        );
    }
}

#[test]
fn error_tests_and_output_together() {
    let it = one("### Q\n```python\nx\n```\n```tests\nassert 1\n```\n```output\n1\n```\n");
    assert!(has_error(&it, "não os dois"), "{it:?}");
}

#[test]
fn error_input_without_output() {
    let it = one("### Q\n```python\nx\n```\n```input\n1\n```\n");
    assert!(has_error(&it, "precisa de um bloco ```output"), "{it:?}");
}

#[test]
fn error_empty_question_or_answer() {
    let it = one("###\n```bash\nls\n```\n");
    assert!(has_error(&it, "pergunta"), "{it:?}");
    let it = one("### Q\n```bash\n  \n```\n");
    assert!(has_error(&it, "A resposta está vazia"), "{it:?}");
}

#[test]
fn error_duplicate_or_unknown_extra_block() {
    let it = one("### Q\n```python\nx\n```\n```tests\na\n```\n```tests\nb\n```\n");
    assert!(has_error(&it, "mais de uma vez"), "{it:?}");
    let it = one("### Q\n```python\nx\n```\n```bash\nls\n```\n");
    assert!(
        has_error(&it, "Bloco desconhecido depois da resposta: bash"),
        "{it:?}"
    );
}

#[test]
fn warning_accepted_on_a_program() {
    let it = one("### Q\n```python\nx = 1\n```\naceitas: x=1\nexige: y\n");
    assert!(it.errors.is_empty());
    assert!(
        it.warnings.iter().any(|w| w.contains("só para comandos")),
        "{it:?}"
    );
    assert_eq!(field(&it, "Aceitas"), None);
    assert_eq!(field(&it, "Exige"), None);
}

#[test]
fn warning_text_before_the_first_heading_and_stray_lines() {
    let p = parse("Meus cards\n\n### Q\n```bash\nls\n```\nqualquer coisa\n");
    assert!(
        p.warnings
            .iter()
            .any(|w| w.contains("antes do primeiro ###")),
        "{p:?}"
    );
    assert!(
        p.items[0]
            .warnings
            .iter()
            .any(|w| w.contains("Linha 7 ignorada")),
        "{p:?}"
    );
    assert!(p.items[0].errors.is_empty());
    let p = parse("\n\n   \n### Q\n```bash\nls\n```\n");
    assert!(p.warnings.is_empty());
    assert!(parse("").warnings.is_empty() && parse("").items.is_empty());
    assert!(!parse("sem perguntas").warnings.is_empty());
}

#[test]
fn section_headings_end_items() {
    let p = parse(
        "# ROS\n### A\n```bash\nls\n```\n## Python\nDescrição da seção\n### B\n```python\nx\n```\n",
    );
    assert_eq!(p.items.len(), 2);
    assert!(p.items.iter().all(|i| i.warnings.is_empty()), "{p:?}");
    assert_eq!(p.items[1].index, 1);
    assert_eq!(p.items[1].line, 8);
    // `### Título ###` drops the closing hashes.
    assert_eq!(one("### Título ###\n```bash\nls\n```").title, "Título");
}

#[test]
fn limits_refuse_the_whole_text() {
    let big = "x".repeat(core_code::markdown::MAX_TEXT_BYTES + 1);
    let p = parse(&big);
    assert!(p.items.is_empty() && !p.errors.is_empty());
    let many: String = (0..=MAX_ITEMS)
        .map(|i| format!("### Q{i}\n```bash\nls\n```\n"))
        .collect();
    let p = parse(&many);
    assert!(
        p.items.is_empty() && p.errors[0].contains("500"),
        "{:?}",
        p.errors
    );
    let ok: String = (0..MAX_ITEMS)
        .map(|i| format!("### Q{i}\n```bash\nls\n```\n"))
        .collect();
    assert_eq!(parse(&ok).items.len(), MAX_ITEMS);
}

#[test]
fn fuzz_never_panics() {
    // Every truncation of the example (at char boundaries) and random byte soup.
    for (i, _) in EXAMPLE.char_indices() {
        let _ = parse(&EXAMPLE[..i]);
        let _ = parse(&EXAMPLE[i..]);
    }
    let mut seed: u64 = 0xDEAD_BEEF;
    let pieces: [&[u8]; 16] = [
        b"###",
        b" ",
        b"\n",
        b"\r",
        b"```",
        b"~~~",
        b"bash",
        b"python",
        b"tests",
        b"> ",
        b"aceitas:",
        b"tags:",
        "é".as_bytes(),
        b"\xff\xfe",
        b"#",
        b"`",
    ];
    for _ in 0..4000 {
        let n = (next(&mut seed) % 60) as usize;
        let mut bytes = Vec::new();
        for _ in 0..n {
            if next(&mut seed).is_multiple_of(4) {
                bytes.push((next(&mut seed) & 0xff) as u8);
            } else {
                bytes.extend_from_slice(pieces[(next(&mut seed) % pieces.len() as u64) as usize]);
            }
        }
        let text = String::from_utf8_lossy(&bytes);
        let p = parse(&text);
        for (i, item) in p.items.iter().enumerate() {
            assert_eq!(item.index as usize, i);
        }
    }
}

fn next(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}
