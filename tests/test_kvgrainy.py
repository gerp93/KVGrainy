import tempfile
import unittest
from pathlib import Path

from PIL import Image

from kvgrainy import iter_images, optimize_image, parse_size_limit


class KVGrainyTests(unittest.TestCase):
    def test_parse_size_limit(self) -> None:
        self.assertEqual(parse_size_limit("500kb"), 500 * 1024)
        self.assertEqual(parse_size_limit("1.5mb"), int(1.5 * 1024 * 1024))
        self.assertEqual(parse_size_limit("2048"), 2048)

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
            image = Image.new("RGB", (1200, 800))
            for x in range(1200):
                for y in range(800):
                    image.putpixel((x, y), ((x * y) % 255, (x + y) % 255, (x * 2 + y * 3) % 255))
            image.save(input_image, quality=98)

            limit_bytes = 40 * 1024
            result = optimize_image(input_image, limit_bytes, output_dir)

            self.assertLessEqual(result.size_bytes, limit_bytes)
            generated = list(output_dir.glob("input_optimized.*"))
            self.assertEqual(len(generated), 1)


if __name__ == "__main__":
    unittest.main()
