import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageCms

from kvgrainy import iter_images, load_static_image, optimize_image, parse_size_limit


class KVGrainyTests(unittest.TestCase):
    def test_parse_size_limit(self) -> None:
        self.assertEqual(parse_size_limit("500kb"), 500 * 1024)
        self.assertEqual(parse_size_limit("1.5mb"), int(1.5 * 1024 * 1024))
        self.assertEqual(parse_size_limit("2048"), 2048)
        with self.assertRaises(ValueError):
            parse_size_limit("")
        with self.assertRaises(ValueError):
            parse_size_limit("abc")
        with self.assertRaises(ValueError):
            parse_size_limit("-10kb")

    def test_iter_images_from_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            image_path = tmp_path / "sample.png"
            Image.new("RGB", (100, 100), "red").save(image_path)
            (tmp_path / "ignore.txt").write_text("x", encoding="utf-8")
            images = iter_images([str(tmp_path)])
            self.assertEqual(images, [image_path.resolve()])

    def test_optimize_image_stays_under_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            input_image = tmp_path / "input.jpg"
            output_dir = tmp_path / "output"
            output_dir.mkdir()
            width, height = 600, 400
            image = Image.new("RGB", (width, height))
            pixels = [
                ((x * y) % 255, (x + y) % 255, (x * 2 + y * 3) % 255)
                for y in range(height)
                for x in range(width)
            ]
            image.putdata(pixels)
            image.save(input_image, quality=98)

            limit_bytes = 40 * 1024
            result = optimize_image(input_image, limit_bytes, output_dir)

            self.assertLessEqual(result.size_bytes, limit_bytes)
            generated = list(output_dir.glob("input_optimized.*"))
            self.assertEqual(len(generated), 1)


def _noise(width: int, height: int, mode: str = "RGB") -> Image.Image:
    image = Image.new("RGB", (width, height))
    image.putdata([((x * y) % 255, (x + y) % 255, (x * 2 + y * 3) % 255) for y in range(height) for x in range(width)])
    return image.convert(mode)


class StaticImageFidelityTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "out"
        self.out.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_exif_orientation_is_applied(self) -> None:
        # Stored landscape 60x40 with orientation 6 (rotate 90 CW) -> displays 40x60.
        image = Image.new("RGB", (60, 40), "blue")
        exif = Image.Exif()
        exif[0x0112] = 6
        path = self.tmp / "phone.jpg"
        image.save(path, exif=exif)
        self.assertEqual(load_static_image(path).size, (40, 60))

        result = optimize_image(path, 50 * 1024, self.out, "jpeg")
        with Image.open(self.out / "phone_optimized.jpg") as out:
            self.assertEqual(out.size[0] < out.size[1], True)
            self.assertNotIn(0x0112, out.getexif())
        self.assertLessEqual(result.size_bytes, 50 * 1024)

    def test_output_has_no_exif_or_gps(self) -> None:
        exif = Image.Exif()
        exif[0x010F] = "SecretCam"
        exif.get_ifd(0x8825)[1] = "N"
        path = self.tmp / "geo.jpg"
        _noise(80, 80).save(path, exif=exif)
        optimize_image(path, 50 * 1024, self.out, "jpeg")
        with Image.open(self.out / "geo_optimized.jpg") as out:
            self.assertEqual(len(out.getexif()), 0)

    def test_icc_profile_handling(self) -> None:
        srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        base = Image.new("RGB", (40, 40), (200, 30, 30))
        path = self.tmp / "srgb.png"
        base.save(path, icc_profile=srgb)
        r, g, _ = load_static_image(path).getpixel((5, 5))
        self.assertAlmostEqual(r, 200, delta=2)
        self.assertAlmostEqual(g, 30, delta=2)

        # An unreadable profile falls back to assuming sRGB instead of failing.
        bad = self.tmp / "bad.png"
        base.save(bad, icc_profile=b"not a profile")
        self.assertEqual(load_static_image(bad).getpixel((5, 5)), (200, 30, 30))

    def test_cmyk_becomes_rgb(self) -> None:
        path = self.tmp / "print.jpg"
        _noise(80, 80, "CMYK").save(path)
        self.assertEqual(load_static_image(path).mode, "RGB")
        result = optimize_image(path, 30 * 1024, self.out)
        self.assertLessEqual(result.size_bytes, 30 * 1024)

    def test_transparent_png_keeps_alpha(self) -> None:
        image = _noise(80, 80, "RGBA")
        image.putalpha(Image.linear_gradient("L").resize((80, 80)))
        path = self.tmp / "alpha.png"
        image.save(path)
        result = optimize_image(path, 40 * 1024, self.out)
        self.assertIn(result.fmt, ("WEBP", "PNG"))
        out = next(self.out.glob("alpha_optimized.*"))
        with Image.open(out) as decoded:
            self.assertIn("A", decoded.getbands())

    def test_image_already_under_limit(self) -> None:
        path = self.tmp / "tiny.png"
        Image.new("RGB", (16, 16), "green").save(path)
        result = optimize_image(path, 500 * 1024, self.out)
        self.assertEqual(result.scale, 1.0)

    def test_impossible_limit_raises(self) -> None:
        path = self.tmp / "big.jpg"
        _noise(200, 200).save(path, quality=95)
        with self.assertRaises(RuntimeError):
            optimize_image(path, 10, self.out)

    def test_animated_gif_stays_gif(self) -> None:
        frames = [Image.new("RGB", (50, 50), c) for c in ("red", "green", "blue")]
        path = self.tmp / "anim.gif"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=100, loop=0)
        result = optimize_image(path, 20 * 1024, self.out)
        self.assertEqual(result.fmt, "GIF")
        with Image.open(self.out / "anim_optimized.gif") as out:
            self.assertEqual(out.n_frames, 3)


if __name__ == "__main__":
    unittest.main()
