from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
import imageio_ffmpeg
import pypdfium2 as pdfium


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "entregas"
TMP = ROOT / "tmp" / "domain-tutorial"
PDF = OUT / "Tutorial_Compra_Dominio_Atenva.pdf"
VIDEO = OUT / "Video_Compra_Dominio_Atenva.mp4"
RENDERED = OUT / "tutorial-dominio-rendered"
LOGO = ROOT / "public" / "assets" / "atenva-logo-green.png"

GREEN = colors.HexColor("#0F371F")
MID = colors.HexColor("#246044")
LIME = colors.HexColor("#AEF53A")
PALE = colors.HexColor("#EFFBD7")
SOFT = colors.HexColor("#F5F8F1")
LINE = colors.HexColor("#DCE5D8")
TEXT = colors.HexColor("#172019")
MUTED = colors.HexColor("#66736A")


def page_decor(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setFillColor(GREEN)
    canvas.rect(0, height - 8 * mm, width, 8 * mm, fill=1, stroke=0)
    canvas.setFillColor(LIME)
    canvas.rect(0, height - 8 * mm, 38 * mm, 8 * mm, fill=1, stroke=0)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(17 * mm, 10 * mm, "ATENVA - DOMINIO E PUBLICACAO")
    canvas.drawRightString(width - 17 * mm, 10 * mm, f"Pagina {doc.page}")
    canvas.restoreState()


def build_pdf():
    OUT.mkdir(exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="AtenvaTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=26, leading=30, textColor=GREEN, spaceAfter=8))
    styles.add(ParagraphStyle(name="AtenvaSubtitle", parent=styles["Normal"], fontName="Helvetica", fontSize=11, leading=16, textColor=MUTED, spaceAfter=14))
    styles.add(ParagraphStyle(name="AtenvaH1", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=GREEN, spaceBefore=8, spaceAfter=8))
    styles.add(ParagraphStyle(name="AtenvaH2", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=12, leading=16, textColor=MID, spaceBefore=7, spaceAfter=5))
    styles.add(ParagraphStyle(name="BodyA", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.4, leading=14, textColor=TEXT, spaceAfter=6))
    styles.add(ParagraphStyle(name="SmallA", parent=styles["BodyText"], fontName="Helvetica", fontSize=7.7, leading=11, textColor=MUTED, spaceAfter=4))
    styles.add(ParagraphStyle(name="Callout", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=9.2, leading=14, textColor=GREEN, leftIndent=8, rightIndent=8, borderColor=LINE, borderWidth=1, borderPadding=8, backColor=PALE, spaceBefore=5, spaceAfter=9))
    styles.add(ParagraphStyle(name="Step", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.2, leading=14, textColor=TEXT, leftIndent=15, firstLineIndent=-15, spaceAfter=7))

    doc = BaseDocTemplate(str(PDF), pagesize=A4, leftMargin=17 * mm, rightMargin=17 * mm, topMargin=18 * mm, bottomMargin=18 * mm, title="Tutorial de compra do dominio Atenva", author="Atenva CRM IA")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=page_decor))

    story = []
    if LOGO.exists():
        from reportlab.platypus import Image as RLImage
        story.append(RLImage(str(LOGO), width=42 * mm, height=16 * mm))
        story.append(Spacer(1, 7 * mm))
    story += [
        Paragraph("Comprar e conectar o dominio da Atenva", styles["AtenvaTitle"]),
        Paragraph("Guia para o socio responsavel pela compra, DNS e conexao com a Vercel. Verificacao feita em 22/10/2026.", styles["AtenvaSubtitle"]),
        Paragraph("Recomendacao direta: compre <b>atenva.com.br</b> no Registro.br por R$ 40 por ano. Ele e curto, institucional, previsivel na renovacao e estava disponivel no momento da consulta. Se o orcamento permitir, compre tambem <b>atenvacrm.com.br</b> para proteger a marca e redirecionar para o principal.", styles["Callout"]),
        Paragraph("1. Disponibilidade e preco consultados", styles["AtenvaH1"]),
    ]

    rows = [
        ["Dominio", "Situacao em 22/10/2026", "Primeiro ano", "Renovacao", "Leitura"],
        ["atenva.com.br", "Disponivel", "R$ 40", "R$ 40/ano", "Melhor opcao"],
        ["atenvacrm.com.br", "Disponivel", "R$ 40", "R$ 40/ano", "Protecao de marca"],
        ["useatenva.com.br", "Disponivel", "R$ 40", "R$ 40/ano", "Alternativa"],
        ["atenva.com", "Indisponivel", "-", "-", "Nao comprar"],
        ["atenvacrm.com", "Disponivel", "US$ 11,25", "US$ 11,25/ano", "Boa opcao global"],
        ["useatenva.com", "Disponivel", "US$ 11,25", "US$ 11,25/ano", "Alternativa global"],
        ["atenva.app", "Disponivel", "US$ 14,99", "US$ 15/ano", "Tecnologico"],
        ["atenva.digital", "Disponivel", "US$ 3,99", "US$ 34/ano", "Promocao enganosa no longo prazo"],
        ["atenva.cloud", "Disponivel", "US$ 7,99", "US$ 24/ano", "Renovacao maior"],
        ["atenva.tech", "Disponivel", "US$ 7,99", "US$ 49/ano", "Renovacao muito maior"],
    ]
    table = Table(rows, colWidths=[31 * mm, 38 * mm, 27 * mm, 29 * mm, 48 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 7.2),
        ("LEADING", (0, 0), (-1, -1), 9.2), ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [table, Spacer(1, 5 * mm), Paragraph("Disponibilidade muda em tempo real. Confirme novamente imediatamente antes de pagar. Valores em dolar foram retornados pela API publica da Vercel e podem sofrer cambio, impostos e alteracao do registrador.", styles["SmallA"]), PageBreak()]

    story += [
        Paragraph("2. O que comprar", styles["AtenvaH1"]),
        Paragraph("Plano economico recomendado", styles["AtenvaH2"]),
        Paragraph("Compre apenas <b>atenva.com.br</b> por R$ 40/ano. Use <b>app.atenva.com.br</b> para o CRM e <b>cliente.atenva.com.br</b> para cada empresa. Nao e necessario comprar um dominio novo por cliente.", styles["BodyA"]),
        Paragraph("Plano de protecao de marca", styles["AtenvaH2"]),
        Paragraph("Compre <b>atenva.com.br</b> e <b>atenvacrm.com.br</b>, totalizando R$ 80/ano. O segundo dominio pode redirecionar para o primeiro. Opcionalmente, compre <b>atenvacrm.com</b> por US$ 11,25/ano para comunicacao internacional.", styles["BodyA"]),
        Paragraph("Evite escolher apenas pelo desconto do primeiro ano. atenva.digital custa US$ 3,99 no primeiro ano, mas a renovacao informada e US$ 34. atenva.tech renova por US$ 49.", styles["Callout"]),
        Paragraph("3. Comprar no Registro.br", styles["AtenvaH1"]),
    ]
    steps = [
        "1. Entre em <link href='https://registro.br'>registro.br</link> e pesquise <b>atenva.com.br</b>.",
        "2. Confirme que aparece <b>Dominio disponivel para registro</b> e clique em Registrar.",
        "3. Entre com a conta que ficara sob controle da Atenva. Use dados reais e ative verificacao em duas etapas.",
        "4. Informe o CPF ou CNPJ que sera o titular legal. Para uma empresa, prefira o CNPJ da Atenva quando estiver disponivel.",
        "5. Revise o contato administrativo e use um e-mail institucional controlado por mais de um socio, com recuperacao protegida.",
        "6. Escolha 1 ano por R$ 40 ou um periodo maior. Pague dentro do proprio Registro.br; ignore boletos enviados por terceiros.",
        "7. Aguarde a confirmacao. O dominio costuma ser ativado rapidamente quando nao ha pendencias cadastrais ou de DNS.",
    ]
    story += [Paragraph(step, styles["Step"]) for step in steps]
    story += [Paragraph("Nao coloque o dominio no CPF, e-mail ou conta de um fornecedor externo sem um acordo formal. O titular legal precisa continuar sob controle da Atenva mesmo se uma parceria terminar.", styles["Callout"]), PageBreak()]

    story += [
        Paragraph("4. Conectar o dominio ao projeto na Vercel", styles["AtenvaH1"]),
        Paragraph("O projeto atual e <b>atenva1/mais-tracao-atenva</b>. A conta principal usa <b>atenvacrm@gmail.com</b>.", styles["BodyA"]),
    ]
    vercel_steps = [
        "1. Entre em <link href='https://vercel.com'>vercel.com</link> com <b>atenvacrm@gmail.com</b>.",
        "2. Abra o time <b>ATENVA</b>, o projeto <b>mais-tracao-atenva</b> e depois <b>Settings - Domains</b>.",
        "3. Adicione primeiro <b>app.atenva.com.br</b> e siga exatamente os registros DNS mostrados pela Vercel.",
        "4. Adicione <b>*.atenva.com.br</b> para permitir enderecos como <b>mais-tracao.atenva.com.br</b> e futuros clientes.",
        "5. Para wildcard, use os nameservers indicados pela Vercel. No Registro.br, abra o dominio, escolha DNS e altere os servidores conforme os valores exibidos na Vercel.",
        "6. Se o dominio ja tiver e-mail, copie antes todos os registros MX, SPF, DKIM e DMARC. Trocar nameservers sem copiar esses registros pode parar o e-mail.",
        "7. Aguarde <b>Valid Configuration</b> e o certificado HTTPS. Nao force uma configuracao diferente do que a Vercel mostrar.",
        "8. Teste o login em app.atenva.com.br e um subdominio de cliente antes de divulgar o novo endereco.",
    ]
    story += [Paragraph(step, styles["Step"]) for step in vercel_steps]
    story += [Paragraph("A compra do dominio e a hospedagem sao coisas separadas. O dominio pode ficar no Registro.br e continuar apontando para a Vercel. Nao e necessario transferir a propriedade para a Vercel.", styles["Callout"]), PageBreak()]

    story += [
        Paragraph("5. Ajustes obrigatorios depois do dominio", styles["AtenvaH1"]),
    ]
    post_rows = [
        ["Area", "O que atualizar"],
        ["Vercel", "PUBLIC_URL/BASE_URL e dominios de producao"],
        ["Google OAuth", "Adicionar https://app.atenva.com.br/api/integrations/google/callback"],
        ["Meta OAuth", "Adicionar https://app.atenva.com.br/api/integrations/meta/callback"],
        ["WhatsApp", "Webhook https://app.atenva.com.br/api/webhooks/whatsapp"],
        ["Meta Lead Ads", "Webhook https://app.atenva.com.br/api/webhooks/meta-leads"],
        ["Politicas", "Publicar privacidade, termos e exclusao de dados no dominio"],
        ["CRM", "Manter a URL antiga ativa durante a transicao"],
    ]
    post_table = Table(post_rows, colWidths=[40 * mm, 133 * mm], repeatRows=1)
    post_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story += [post_table, Spacer(1, 5 * mm), Paragraph("Faça a mudanca em duas etapas: primeiro adicione e teste o dominio; depois altere URLs de OAuth e webhooks. Nao remova a URL vercel.app ate Google, Meta e WhatsApp terem sido testados no novo endereco.", styles["Callout"])]
    story += [Paragraph("6. Checklist final", styles["AtenvaH1"])]
    checks = [
        "Dominio aparece como titularidade da Atenva no Registro.br.",
        "Acesso e recuperacao da conta estao no cofre de senhas.",
        "app.atenva.com.br abre com HTTPS valido.",
        "Um subdominio de cliente abre o tenant correto.",
        "Login e sessao persistente funcionam no dominio novo.",
        "Google Agenda conecta e sincroniza.",
        "Meta conecta e atualiza metricas.",
        "WhatsApp envia, recebe e atualiza status.",
        "Webhooks respondem sem erro.",
        "E-mail do dominio continua funcionando, se existir.",
    ]
    story += [Paragraph(f"[ ] {item}", styles["Step"]) for item in checks]
    story += [PageBreak(), Paragraph("7. Links oficiais", styles["AtenvaH1"])]
    links = [
        ("Registro.br - pesquisa e compra", "https://registro.br/"),
        ("Registro.br - preco de R$ 40 por ano", "https://registro.br/dominio"),
        ("Registro.br - tutorial de registro", "https://www.registro.br/ajuda/tutoriais-administrativos/"),
        ("RDAP oficial .br", "https://rdap.registro.br/"),
        ("Vercel - dominios", "https://vercel.com/docs/domains"),
        ("Vercel - adicionar dominio", "https://vercel.com/docs/domains/working-with-domains/add-a-domain"),
        ("Projeto Atenva", "https://vercel.com/atenva1/mais-tracao-atenva"),
    ]
    for label, url in links:
        story.append(Paragraph(f"- <link href='{url}' color='#246044'>{label}</link>", styles["BodyA"]))
    story += [Spacer(1, 8 * mm), Paragraph("Resumo para o socio: compre atenva.com.br no Registro.br, mantenha a titularidade com a Atenva, conecte app.atenva.com.br e *.atenva.com.br ao projeto Vercel e so depois atualize Google, Meta e WhatsApp.", styles["Callout"])]
    doc.build(story)


def font(size, bold=False):
    candidates = [
        Path("C:/Windows/Fonts/seguisb.ttf") if bold else Path("C:/Windows/Fonts/segoeui.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf") if bold else Path("C:/Windows/Fonts/arial.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def wrap(draw, text, face, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textbbox((0, 0), trial, font=face)[2] <= width:
            line = trial
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def slide(title, kicker, bullets, number, total, accent="#AEF53A"):
    image = Image.new("RGB", (1280, 720), "#F4F7F1")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1280, 14), fill=accent)
    draw.rounded_rectangle((55, 45, 1225, 666), radius=28, fill="#FFFFFF", outline="#DCE5D8", width=2)
    draw.text((90, 76), "ATENVA", font=font(24, True), fill="#0F371F")
    draw.text((1085, 78), f"{number:02d}/{total:02d}", font=font(17, True), fill="#68756C")
    draw.text((90, 126), kicker.upper(), font=font(16, True), fill="#2F6740")
    y = 164
    title_face = font(40, True)
    for line in wrap(draw, title, title_face, 1030):
        draw.text((90, y), line, font=title_face, fill="#142A1A")
        y += 51
    y += 18
    body_face = font(24)
    for bullet in bullets:
        draw.rounded_rectangle((94, y + 7, 108, y + 21), radius=5, fill=accent)
        lines = wrap(draw, bullet, body_face, 1000)
        for index, line in enumerate(lines):
            draw.text((128, y + index * 33), line, font=body_face, fill="#283A2F")
        y += max(50, len(lines) * 33 + 14)
    draw.text((90, 625), "Disponibilidade consultada em 22/10/2026 - confirme antes do pagamento", font=font(15), fill="#758079")
    return image


def build_video():
    TMP.mkdir(parents=True, exist_ok=True)
    frames = TMP / "frames"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir(parents=True)
    slides = [
        ("Comprar o dominio da Atenva", "Tutorial para o socio", ["Opcao recomendada: atenva.com.br", "Compra no Registro.br por R$ 40 ao ano", "Conexao com Vercel, subdominios e integracoes"]),
        ("O que esta disponivel agora", "Pesquisa oficial", ["atenva.com.br e atenvacrm.com.br: disponiveis", "atenvacrm.com e useatenva.com: US$ 11,25 ao ano", "atenva.com: indisponivel", "Promocoes .digital e .tech renovam muito mais caro"]),
        ("Escolha recomendada", "Menor custo com boa marca", ["Compre atenva.com.br por R$ 40 ao ano", "Opcional: atenvacrm.com.br para proteger a marca", "Um unico dominio cria subdominios para todos os clientes"]),
        ("Compra no Registro.br", "Passo a passo", ["Pesquise atenva.com.br e clique em Registrar", "Use CPF ou CNPJ do titular legal da Atenva", "Mantenha e-mail, recuperacao e 2FA sob controle dos socios", "Pague somente dentro do Registro.br"]),
        ("Conecte na Vercel", "Projeto mais-tracao-atenva", ["Entre com atenvacrm@gmail.com", "Adicione app.atenva.com.br", "Adicione *.atenva.com.br para os clientes", "Use exatamente os registros DNS mostrados pela Vercel"]),
        ("Cuidado com o e-mail", "Antes de trocar nameservers", ["Copie MX, SPF, DKIM e DMARC existentes", "Wildcard pode exigir nameservers da Vercel", "Sem copiar os registros, o e-mail do dominio pode parar"]),
        ("Atualize as integracoes", "Depois que o HTTPS estiver valido", ["Google: callback no app.atenva.com.br", "Meta: OAuth e webhooks no dominio novo", "WhatsApp: webhook oficial no dominio novo", "Mantenha vercel.app durante a transicao"]),
        ("Teste antes de divulgar", "Checklist", ["Login e sessao persistente", "Subdominio abre o cliente correto", "Google sincroniza agenda", "Meta atualiza metricas", "WhatsApp envia, recebe e confirma status"]),
        ("Resumo final", "Decisao sugerida", ["Comprar agora: atenva.com.br", "Custo: R$ 40 ao ano", "Opcional: atenvacrm.com.br e atenvacrm.com", "Consulte o PDF para o roteiro completo"]),
    ]
    paths = []
    for index, data in enumerate(slides, 1):
        path = frames / f"slide-{index:02d}.png"
        slide(*data, index, len(slides)).save(path)
        paths.append(path)
    concat = TMP / "slides.txt"
    concat.write_text("".join([f"file '{path.as_posix()}'\nduration 6\n" for path in paths] + [f"file '{paths[-1].as_posix()}'\n"]), encoding="utf-8")
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-movflags", "+faststart", str(VIDEO)], check=True, capture_output=True)


def render_pdf():
    shutil.rmtree(RENDERED, ignore_errors=True)
    RENDERED.mkdir(parents=True)
    pdf = pdfium.PdfDocument(str(PDF))
    images = []
    for index, page in enumerate(pdf):
        image = page.render(scale=1.45).to_pil().convert("RGB")
        path = RENDERED / f"page-{index + 1:02d}.png"
        image.save(path)
        images.append(image)
    thumb_width = 360
    thumbs = []
    for image in images:
        ratio = thumb_width / image.width
        thumbs.append(image.resize((thumb_width, int(image.height * ratio))))
    gap = 18
    cols = 2
    rows = (len(thumbs) + cols - 1) // cols
    cell_height = max(image.height for image in thumbs)
    sheet = Image.new("RGB", (cols * thumb_width + (cols + 1) * gap, rows * cell_height + (rows + 1) * gap), "#E9EEE6")
    for index, image in enumerate(thumbs):
        x = gap + (index % cols) * (thumb_width + gap)
        y = gap + (index // cols) * (cell_height + gap)
        sheet.paste(image, (x, y))
    sheet.save(RENDERED / "contact-sheet.png")
    return len(images)


if __name__ == "__main__":
    build_pdf()
    build_video()
    pages = render_pdf()
    print(f"PDF: {PDF}")
    print(f"VIDEO: {VIDEO}")
    print(f"PAGES: {pages}")
