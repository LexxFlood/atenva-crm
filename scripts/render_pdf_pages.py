from pathlib import Path
import pypdfium2 as pdfium

root=Path(__file__).resolve().parents[1]
pdf_path=root/'entregas/Tutorial_Atenva_Producao_Dominio_Integracoes.pdf'
out=root/'entregas/rendered-tutorial'
out.mkdir(parents=True,exist_ok=True)
pdf=pdfium.PdfDocument(str(pdf_path))
for index,page in enumerate(pdf):
    image=page.render(scale=1.5).to_pil()
    image.save(out/f'page-{index+1:02d}.png')
print(f'{len(pdf)} pages rendered to {out}')
