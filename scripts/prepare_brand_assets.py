from pathlib import Path

from PIL import Image


PROJECT = Path(r"C:\Users\Daniel\Downloads\projeto CRM\whatscrm-ai")
SOURCES = {
    "green": Path(r"C:\Users\Daniel\.codex\generated_images\01a04b40-1b5b-71a3-8c07-7f4dfe5a1334\exec-497c998c-774f-4959-908d-5f4f6321d908.png"),
    "navy": Path(r"C:\Users\Daniel\.codex\generated_images\01a04b40-1b5b-71a3-8c07-7f4dfe5a1334\exec-8add219d-0b92-484f-9943-354e333e8572.png"),
}


def remove_white_background(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = []
    for red, green, blue, _ in rgba.getdata():
        distance = max(255 - red, 255 - green, 255 - blue)
        if distance <= 7:
            alpha = 0
        elif distance >= 38:
            alpha = 255
        else:
            alpha = round((distance - 7) * 255 / 31)
        pixels.append((red, green, blue, alpha))
    rgba.putdata(pixels)
    return rgba


def crop_alpha(image: Image.Image, margin: int = 20) -> Image.Image:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        raise ValueError("No visible pixels found")
    left, top, right, bottom = bbox
    left = max(0, left - margin)
    top = max(0, top - margin)
    right = min(image.width, right + margin)
    bottom = min(image.height, bottom + margin)
    return image.crop((left, top, right, bottom))


def fit_canvas(image: Image.Image, size: tuple[int, int], padding: int) -> Image.Image:
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    available = (size[0] - padding * 2, size[1] - padding * 2)
    copy = image.copy()
    copy.thumbnail(available, Image.Resampling.LANCZOS)
    x = (size[0] - copy.width) // 2
    y = (size[1] - copy.height) // 2
    canvas.alpha_composite(copy, (x, y))
    return canvas


def save_variant(name: str, source: Path) -> None:
    image = remove_white_background(Image.open(source))
    lockup = crop_alpha(image, 24)

    # The symbol occupies the upper portion of the generated master.
    symbol_region = image.crop((0, 0, image.width, round(image.height * 0.66)))
    mark = crop_alpha(symbol_region, 18)

    brand_dir = PROJECT / "brand"
    public_dir = PROJECT / "public" / "assets"
    brand_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)

    lockup.save(brand_dir / f"atenva-logo-{name}.png", optimize=True)
    mark.save(brand_dir / f"atenva-mark-{name}.png", optimize=True)
    fit_canvas(lockup, (1200, 720), 44).save(public_dir / f"atenva-logo-{name}.png", optimize=True)
    fit_canvas(mark, (256, 256), 18).save(public_dir / f"atenva-mark-{name}.png", optimize=True)


for variant, path in SOURCES.items():
    save_variant(variant, path)

print("Prepared Atenva green and navy logo assets.")
