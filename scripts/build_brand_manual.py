from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(r"C:\Users\Daniel\Downloads\projeto CRM\whatscrm-ai")
OUTPUT = ROOT / "brand" / "Manual de Marca Atenva.docx"
LOGO_GREEN = ROOT / "brand" / "atenva-logo-green.png"
LOGO_NAVY = ROOT / "brand" / "atenva-logo-navy.png"
MARK_GREEN = ROOT / "brand" / "atenva-mark-green.png"
MARK_NAVY = ROOT / "brand" / "atenva-mark-navy.png"

BLACK = "000000"
INK = "172019"
MUTED = "6C756E"
LINE = "D9D9D9"
LIME = "B8F24A"
FOREST = "142A1A"
EMERALD = "214B2C"
LEAF = "2F6740"
MEDIUM = "3B8251"
NAVY = "0B2D5C"
OFFWHITE = "F6F8F3"
PALE = "EFFBD7"


def set_cell_shading(cell, fill):
    props = cell._tc.get_or_add_tcPr()
    shade = props.find(qn("w:shd"))
    if shade is None:
        shade = OxmlElement("w:shd")
        props.append(shade)
    shade.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=150, start=150, bottom=150, end=150):
    props = cell._tc.get_or_add_tcPr()
    margins = props.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        props.append(margins)
    for edge, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        tag = margins.find(qn(f"w:{edge}"))
        if tag is None:
            tag = OxmlElement(f"w:{edge}")
            margins.append(tag)
        tag.set(qn("w:w"), str(value))
        tag.set(qn("w:type"), "dxa")


def set_table_borders(table, color=LINE, size="6"):
    props = table._tbl.tblPr
    borders = props.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        props.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), size)
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), color)
        borders.append(element)


def set_repeat_table_header(row):
    props = row._tr.get_or_add_trPr()
    repeat = OxmlElement("w:tblHeader")
    repeat.set(qn("w:val"), "true")
    props.append(repeat)


def set_run_font(run, name="Aptos", size=10.8, color=INK, bold=False):
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), name)
    run.font.size = Pt(size)
    run.font.color.rgb = RGBColor.from_string(color)
    run.bold = bold


def add_text(paragraph, text, **kwargs):
    run = paragraph.add_run(text)
    set_run_font(run, **kwargs)
    return run


def add_heading(doc, text, level=1):
    paragraph = doc.add_paragraph(style=f"Heading {level}")
    paragraph.paragraph_format.keep_with_next = True
    add_text(paragraph, text, size=21 if level == 1 else 14, color=BLACK, bold=True)
    return paragraph


def add_body(doc, text, after=8, bold_lead=None):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(after)
    paragraph.paragraph_format.line_spacing = 1.16
    if bold_lead and text.startswith(bold_lead):
        add_text(paragraph, bold_lead, bold=True)
        add_text(paragraph, text[len(bold_lead):])
    else:
        add_text(paragraph, text)
    return paragraph


def add_bullet(doc, text):
    paragraph = doc.add_paragraph(style="List Bullet")
    paragraph.paragraph_format.space_after = Pt(4)
    paragraph.paragraph_format.line_spacing = 1.1
    add_text(paragraph, text)
    return paragraph


def add_page_title(doc, kicker, title, intro):
    kicker_p = doc.add_paragraph()
    kicker_p.paragraph_format.space_after = Pt(5)
    add_text(kicker_p, kicker.upper(), size=8.5, color=MEDIUM, bold=True)
    add_heading(doc, title, 1)
    intro_p = doc.add_paragraph()
    intro_p.paragraph_format.space_after = Pt(18)
    intro_p.paragraph_format.line_spacing = 1.2
    add_text(intro_p, intro, size=11.5, color=MUTED)


def add_page_number(paragraph):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)
    set_run_font(run, size=8, color=MUTED)


doc = Document()
section = doc.sections[0]
section.page_width = Inches(8.5)
section.page_height = Inches(11)
section.top_margin = Inches(0.72)
section.bottom_margin = Inches(0.68)
section.left_margin = Inches(0.82)
section.right_margin = Inches(0.82)

styles = doc.styles
normal = styles["Normal"]
normal.font.name = "Aptos"
normal._element.rPr.rFonts.set(qn("w:ascii"), "Aptos")
normal._element.rPr.rFonts.set(qn("w:hAnsi"), "Aptos")
normal.font.size = Pt(10.8)
normal.font.color.rgb = RGBColor.from_string(INK)
for style_name in ("Title", "Heading 1", "Heading 2"):
    style = styles[style_name]
    style.font.name = "Aptos Display"
    style._element.rPr.rFonts.set(qn("w:ascii"), "Aptos Display")
    style._element.rPr.rFonts.set(qn("w:hAnsi"), "Aptos Display")
    style.font.color.rgb = RGBColor(0, 0, 0)

footer = section.footer
footer_p = footer.paragraphs[0]
footer_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
add_text(footer_p, "ATENVA   |   MANUAL DE MARCA   |   ", size=8, color=MUTED, bold=True)
add_page_number(footer_p)

# Capa
cover_logo = doc.add_paragraph()
cover_logo.alignment = WD_ALIGN_PARAGRAPH.CENTER
cover_logo.paragraph_format.space_before = Pt(42)
cover_logo.paragraph_format.space_after = Pt(36)
cover_logo.add_run().add_picture(str(LOGO_GREEN), width=Inches(5.6))

title = doc.add_paragraph(style="Title")
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
title.paragraph_format.space_after = Pt(10)
add_text(title, "Manual de marca Atenva", name="Aptos Display", size=28, color=BLACK, bold=True)
subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
subtitle.paragraph_format.space_after = Pt(150)
add_text(subtitle, "Sistema visual para produto digital, comunicação e relacionamento", size=12, color=MUTED)
version = doc.add_paragraph()
version.alignment = WD_ALIGN_PARAGRAPH.CENTER
add_text(version, "Versão 1.0   Setembro de 2026", size=9, color=MUTED)

# Essência
doc.add_page_break()
add_page_title(doc, "01 Identidade", "A marca Atenva", "Atenva é a plataforma que transforma conversas em relações comerciais organizadas, mensuráveis e contínuas.")
add_heading(doc, "Posicionamento", 2)
add_body(doc, "A marca combina proximidade humana com inteligência operacional. Sua identidade deve transmitir clareza, confiança, movimento e evolução sem parecer fria ou excessivamente tecnológica.")
add_heading(doc, "Assinatura verbal", 2)
add_body(doc, "Nome oficial: Atenva", bold_lead="Nome oficial:")
add_body(doc, "Descriptor: Plataforma de conversão relacional", bold_lead="Descriptor:")
add_body(doc, "Linha de produto: CRM IA para WhatsApp", bold_lead="Linha de produto:")
add_heading(doc, "Personalidade", 2)
for item in (
    "Clara: simplifica processos comerciais e explica o próximo passo.",
    "Próxima: conversa com naturalidade e respeita o contexto de cada relação.",
    "Atenta: acompanha sinais, tarefas e oportunidades sem perder continuidade.",
    "Confiante: orienta decisões com dados e linguagem direta.",
):
    add_bullet(doc, item)
add_heading(doc, "Princípio visual", 2)
add_body(doc, "O símbolo em forma de A é construído como uma faixa em movimento. A transição entre verde-floresta e lima representa a passagem de uma conversa inicial para uma relação mais valiosa.")

# Logos
doc.add_page_break()
add_page_title(doc, "02 Sistema de logo", "Assinaturas oficiais", "A versão verde é a assinatura principal. A versão azul-marinho funciona como alternativa institucional e para materiais que pedem maior sobriedade.")
table = doc.add_table(rows=1, cols=2)
table.alignment = WD_TABLE_ALIGNMENT.CENTER
table.autofit = False
set_table_borders(table)
for index, (label, path, note) in enumerate((
    ("Principal verde", LOGO_GREEN, "Uso preferencial em interfaces, apresentações e campanhas."),
    ("Alternativa azul-marinho", LOGO_NAVY, "Uso institucional, documentos formais e impressão simplificada."),
)):
    cell = table.rows[0].cells[index]
    cell.width = Inches(3.25)
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    set_cell_margins(cell, 220, 180, 220, 180)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(str(path), width=Inches(2.75))
    p2 = cell.add_paragraph()
    p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_text(p2, label, size=10.5, color=BLACK, bold=True)
    p3 = cell.add_paragraph()
    p3.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_text(p3, note, size=8.7, color=MUTED)
add_body(doc, "A assinatura completa inclui símbolo, nome e descriptor. O símbolo isolado pode ser usado em avatar, favicon, botão de aplicativo e espaços menores.", after=13)
add_heading(doc, "Área de proteção", 2)
add_body(doc, "Reserve ao redor da logo uma distância mínima equivalente à largura da haste vertical da letra A do nome Atenva. Nenhum texto, borda ou outro símbolo deve entrar nessa área.")
add_heading(doc, "Tamanho mínimo", 2)
for item in (
    "Assinatura completa digital: 220 px de largura.",
    "Assinatura completa impressa: 38 mm de largura.",
    "Símbolo isolado digital: 28 px. Impresso: 8 mm.",
):
    add_bullet(doc, item)

# Paleta
doc.add_page_break()
add_page_title(doc, "03 Cores", "Paleta Atenva", "O lima concentra energia e ação. Os verdes estruturam profundidade, confiança e continuidade. O azul-marinho oferece uma rota institucional complementar.")
colors = [
    ("Lima Atenva", LIME, "184 242 74", "Destaques, estados ativos e chamadas para ação", INK),
    ("Verde floresta", FOREST, "20 42 26", "Fundos escuros, navegação e contraste principal", "FFFFFF"),
    ("Verde profundo", EMERALD, "33 75 44", "Superfícies de marca e gradientes", "FFFFFF"),
    ("Verde folha", LEAF, "47 103 64", "Ícones, gráficos e estados positivos", "FFFFFF"),
    ("Verde médio", MEDIUM, "59 130 81", "Apoio visual e transições", "FFFFFF"),
    ("Azul-marinho", NAVY, "11 45 92", "Versão institucional e materiais formais", "FFFFFF"),
    ("Branco quente", OFFWHITE, "246 248 243", "Fundo principal do tema claro", INK),
    ("Tinta", INK, "23 32 25", "Texto e conteúdo de alta leitura", "FFFFFF"),
]
table = doc.add_table(rows=1, cols=4)
table.alignment = WD_TABLE_ALIGNMENT.CENTER
table.autofit = False
widths = [1.62, 1.18, 1.25, 2.5]
headers = ["Cor", "HEX", "RGB", "Uso"]
for i, header in enumerate(headers):
    cell = table.rows[0].cells[i]
    cell.width = Inches(widths[i])
    set_cell_shading(cell, NAVY)
    set_cell_margins(cell)
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER if i in (1, 2) else WD_ALIGN_PARAGRAPH.LEFT
    add_text(p, header, size=9, color="FFFFFF", bold=True)
set_repeat_table_header(table.rows[0])
for row_index, (name, hex_code, rgb, use, text_color) in enumerate(colors):
    cells = table.add_row().cells
    for cell in cells:
        set_cell_margins(cell)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    set_cell_shading(cells[0], hex_code)
    add_text(cells[0].paragraphs[0], name, size=8.8, color=text_color, bold=True)
    cells[1].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    cells[2].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_text(cells[1].paragraphs[0], f"#{hex_code}", size=8.8)
    add_text(cells[2].paragraphs[0], rgb, size=8.8)
    add_text(cells[3].paragraphs[0], use, size=8.5)
    if row_index % 2:
        for cell in cells[1:]:
            set_cell_shading(cell, "F4F6F3")
set_table_borders(table)
add_body(doc, "Contraste: use texto verde-floresta ou tinta sobre o lima. Em fundos verde-floresta e azul-marinho, prefira texto branco. O lima deve destacar ações e informações curtas, não parágrafos extensos.", after=0, bold_lead="Contraste:")

# Fundos e temas
doc.add_page_break()
add_page_title(doc, "04 Aplicação", "Temas claro e escuro", "A identidade mantém a mesma hierarquia nos dois temas. O que muda é a superfície; o lima continua sendo o sinal de ação e progresso.")
theme_table = doc.add_table(rows=2, cols=2)
theme_table.alignment = WD_TABLE_ALIGNMENT.CENTER
theme_table.autofit = False
set_table_borders(theme_table)
for column, label in enumerate(("Tema claro", "Tema escuro")):
    cell = theme_table.rows[0].cells[column]
    set_cell_shading(cell, "F1F3F0" if column == 0 else FOREST)
    set_cell_margins(cell, 170, 180, 170, 180)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_text(p, label, size=10, color=BLACK if column == 0 else "FFFFFF", bold=True)
for column in range(2):
    cell = theme_table.rows[1].cells[column]
    cell.width = Inches(3.25)
    set_cell_shading(cell, "FFFFFF" if column == 0 else "0B1510")
    set_cell_margins(cell, 260, 220, 260, 220)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(str(MARK_GREEN), width=Inches(1.65))
    brand_p = cell.add_paragraph()
    brand_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_text(brand_p, "ATENVA", size=19, color=FOREST if column == 0 else "FFFFFF", bold=True)
    desc_p = cell.add_paragraph()
    desc_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_text(desc_p, "CRM IA", size=8.5, color=MUTED if column == 0 else "B8C5BB", bold=True)
add_heading(doc, "Regras de fundo", 2)
for item in (
    "Em branco ou branco quente, use a versão verde completa.",
    "Em fundos escuros, use o símbolo verde com o nome em branco.",
    "Em fotografia, aplique a marca apenas sobre área uniforme e com contraste suficiente.",
    "Não aplique o lima sobre fundo claro sem contorno ou estrutura verde que preserve a leitura.",
):
    add_bullet(doc, item)

# Tipografia e UI
doc.add_page_break()
add_page_title(doc, "05 Tipografia e interface", "Clareza em cada contato", "A tipografia deve ser neutra, contemporânea e funcional. A interface usa contraste, espaço e hierarquia antes de recorrer a ornamentos.")
add_heading(doc, "Família principal", 2)
add_body(doc, "Inter é a tipografia preferencial do produto e da comunicação digital. Quando não estiver disponível, use Segoe UI, Arial ou outra sans serif de alta legibilidade.")
type_table = doc.add_table(rows=1, cols=3)
type_table.alignment = WD_TABLE_ALIGNMENT.CENTER
type_table.autofit = False
for i, header in enumerate(("Função", "Peso", "Orientação")):
    cell = type_table.rows[0].cells[i]
    set_cell_shading(cell, NAVY)
    set_cell_margins(cell)
    add_text(cell.paragraphs[0], header, size=9, color="FFFFFF", bold=True)
rows = [
    ("Títulos", "700 a 800", "Frases curtas, contraste alto e entrelinha compacta"),
    ("Subtítulos", "600 a 700", "Hierarquia clara sem competir com o título"),
    ("Texto", "400 a 500", "Leitura contínua, entrelinha confortável"),
    ("Rótulos", "600 a 750", "Poucas palavras, podendo usar caixa alta com moderação"),
    ("Dados", "650 a 800", "Números em destaque e unidade sempre identificada"),
]
for row_index, values in enumerate(rows):
    cells = type_table.add_row().cells
    for i, value in enumerate(values):
        set_cell_margins(cells[i])
        add_text(cells[i].paragraphs[0], value, size=8.7, bold=i == 0)
        if row_index % 2:
            set_cell_shading(cells[i], "F4F6F3")
set_table_borders(type_table)
add_heading(doc, "Componentes digitais", 2)
for item in (
    "Botão principal: verde-floresta no tema claro e verde profundo no tema escuro; texto branco.",
    "Destaque: lima com texto verde-floresta para status, progresso e confirmação.",
    "Cards: branco no tema claro e verde quase preto no tema escuro, sempre com borda discreta.",
    "Gráficos: comece pelo lima e avance pelos verdes médios e profundos antes de usar cores auxiliares.",
):
    add_bullet(doc, item)

# Uso correto
doc.add_page_break()
add_page_title(doc, "06 Consistência", "Uso correto da marca", "A força da identidade depende da repetição consistente. Preserve forma, proporção, contraste e respiro em todos os pontos de contato.")
add_heading(doc, "Faça", 2)
for item in (
    "Use sempre os arquivos oficiais e mantenha a proporção original.",
    "Escolha a versão de maior contraste para o fundo disponível.",
    "Mantenha a área de proteção e o tamanho mínimo.",
    "Use o símbolo isolado quando a assinatura completa ficar pequena demais.",
):
    add_bullet(doc, item)
add_heading(doc, "Não faça", 2)
for item in (
    "Não estique, incline, gire ou redesenhe o símbolo.",
    "Não troque as cores por tons fora da paleta oficial.",
    "Não aplique sombras, contornos, brilhos ou efeitos adicionais.",
    "Não altere o espaçamento entre símbolo, nome e descriptor.",
    "Não use a assinatura sobre fundos com pouco contraste ou excesso de informação.",
):
    add_bullet(doc, item)
add_heading(doc, "Arquivos mestres", 2)
add_body(doc, "As versões verde e azul-marinho, além dos símbolos isolados, acompanham este manual em PNG com fundo transparente. Para novas aplicações, derive sempre desses arquivos.")

doc.core_properties.title = "Manual de marca Atenva"
doc.core_properties.subject = "Identidade visual, logo, cores, tipografia e aplicação digital da Atenva"
doc.core_properties.author = "Atenva"
doc.core_properties.keywords = "Atenva, marca, logo, identidade visual, CRM"
doc.save(OUTPUT)
print(OUTPUT)
