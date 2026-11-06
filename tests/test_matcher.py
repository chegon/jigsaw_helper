from __future__ import annotations

import json
import unittest
from io import BytesIO

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

from demo import make_demo
from puzzle_helper import (
    Candidate,
    FeatureMatcher,
    Photo,
    Piece,
    Settings,
    analyze,
    assess_edges,
    export_results,
    extract_pieces,
    foreground_mask,
    load_photo,
    render_reference,
    resize_photo,
    template_candidates,
)


def square_piece(size: int = 32) -> Piece:
    image = np.full((size, size, 3), 150, np.uint8)
    mask = np.full((size, size), 255, np.uint8)
    contour = np.int32(
        [[[0, 0]], [[size - 1, 0]], [[size - 1, size - 1]], [[0, size - 1]]]
    )
    return Piece("1-01", "test.png", image, mask, contour, (0, 0, size, size))


def candidate_at(x: int, y: int, size: int = 32) -> Candidate:
    transform = np.float64([[1, 0, x], [0, 1, y], [0, 0, 1]])
    polygon = np.float32(
        [[x, y], [x + size - 1, y], [x + size - 1, y + size - 1], [x, y + size - 1]]
    )
    return Candidate(transform, polygon, 0.85, "features", 12, True)


class ImageLoadingTests(unittest.TestCase):
    def test_alpha_and_resize(self) -> None:
        image = np.zeros((80, 120, 4), np.uint8)
        image[20:60, 30:90] = (220, 80, 40, 255)
        buffer = BytesIO()
        Image.fromarray(image).save(buffer, format="PNG")
        photo = load_photo(buffer.getvalue())
        self.assertIsNotNone(photo.alpha)
        self.assertEqual(photo.image[0, 0].tolist(), [255, 255, 255])
        self.assertEqual(photo.image[30, 40].tolist(), [40, 80, 220])
        resized = resize_photo(photo, 60)
        self.assertEqual(resized.image.shape, (40, 60, 3))
        self.assertEqual(resized.alpha.shape, (40, 60))

    def test_exif_orientation(self) -> None:
        image = Image.new("RGB", (40, 80), "red")
        exif = Image.Exif()
        exif[274] = 6
        buffer = BytesIO()
        image.save(buffer, format="JPEG", exif=exif)
        self.assertEqual(load_photo(buffer.getvalue()).image.shape[:2], (40, 80))

    def test_invalid_images_raise(self) -> None:
        with self.assertRaises(ValueError):
            load_photo(b"")
        with self.assertRaises(UnidentifiedImageError):
            load_photo(b"not an image")


class SegmentationTests(unittest.TestCase):
    def test_light_dark_and_sampled_backgrounds(self) -> None:
        for mode, color in (("auto", (30, 80, 40)), ("light", (250, 250, 250)), ("dark", (5, 5, 5))):
            with self.subTest(mode=mode):
                image = np.full((200, 300, 3), color, np.uint8)
                cv2.rectangle(image, (35, 40), (105, 130), (180, 90, 150), -1)
                cv2.rectangle(image, (165, 50), (255, 140), (70, 180, 220), -1)
                pieces, preview, messages = extract_pieces(
                    Photo(image), "test.png", "2", Settings(background=mode)
                )
                self.assertEqual(len(pieces), 2)
                self.assertEqual([piece.identifier for piece in pieces], ["2-01", "2-02"])
                self.assertEqual(preview.shape, image.shape)
                self.assertEqual(messages, [])

    def test_alpha_takes_precedence_over_background(self) -> None:
        image = np.full((100, 160, 3), 70, np.uint8)
        alpha = np.zeros((100, 160), np.uint8)
        alpha[20:70, 30:90] = 255
        mask = foreground_mask(Photo(image, alpha), Settings(background="dark"))
        self.assertEqual(int(np.count_nonzero(mask)), 50 * 60)

    def test_assembled_mask_preserves_a_missing_piece_hole(self) -> None:
        image = np.full((200, 200, 3), 245, np.uint8)
        image[20:180, 20:180] = (60, 100, 160)
        image[70:120, 70:120] = 245
        assembled_mask = foreground_mask(Photo(image), Settings(), fill_holes=False)
        self.assertEqual(assembled_mask[90, 90], 0)
        self.assertEqual(assembled_mask[40, 40], 255)
        piece_mask = foreground_mask(Photo(image), Settings())
        self.assertEqual(piece_mask[90, 90], 255)

    def test_small_noise_and_border_regions_are_not_pieces(self) -> None:
        image = np.full((200, 300, 3), 245, np.uint8)
        cv2.rectangle(image, (0, 20), (35, 70), (50, 80, 140), -1)
        cv2.rectangle(image, (80, 50), (155, 140), (50, 80, 140), -1)
        cv2.rectangle(image, (220, 150), (223, 153), (50, 80, 140), -1)
        pieces, _, messages = extract_pieces(Photo(image), "test.png", "1", Settings())
        self.assertEqual(len(pieces), 1)
        self.assertTrue(any("接触照片边缘" in message for message in messages))

    def test_no_piece_and_piece_limit_are_explicit(self) -> None:
        blank = Photo(np.full((200, 300, 3), 245, np.uint8))
        pieces, _, messages = extract_pieces(blank, "blank.png", "1", Settings())
        self.assertEqual(pieces, [])
        self.assertTrue(any("没有分离出" in message for message in messages))
        image = blank.image.copy()
        for x in (20, 110, 200):
            cv2.rectangle(image, (x, 30), (x + 50, 100), (50, 80, 140), -1)
        pieces, _, messages = extract_pieces(
            Photo(image), "test.png", "1", Settings(max_pieces=2)
        )
        self.assertEqual(len(pieces), 2)
        self.assertTrue(any("只处理前" in message for message in messages))


class FeatureMatchingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.reference, cls.assembled, cls.loose = make_demo()

    def test_four_rotated_pieces_and_assembled_alignment(self) -> None:
        result = analyze(
            self.reference,
            self.loose,
            self.assembled,
            Settings(template_fallback=False, approximate_columns=5),
        )
        self.assertEqual(len(result.pieces), 4)
        self.assertIsNotNone(result.occupied_mask, result.messages)
        expected = np.float32([[320, 60], [320, 180], [192, 300], [576, 300]])
        matched = []
        for piece_result in result.pieces:
            self.assertTrue(piece_result.candidates, piece_result.piece.identifier)
            candidate = piece_result.candidates[0]
            self.assertTrue(candidate.reliable)
            self.assertEqual(candidate.method, "features")
            distances = np.linalg.norm(expected - candidate.center, axis=1)
            self.assertLess(float(distances.min()), 22)
            matched.append(int(distances.argmin()))
            self.assertLess(candidate.overlap, 0.08)
        self.assertEqual(len(set(matched)), 4)
        self.assertGreaterEqual(
            sum(piece.candidates[0].edge_score is not None for piece in result.pieces),
            3,
        )
        payload = export_results(result)
        self.assertEqual(payload["reference_size"], {"width": 640, "height": 480})
        self.assertFalse(payload["scores_are_probabilities"])
        self.assertEqual(len(payload["pieces"]), 4)
        json.dumps(payload, allow_nan=False)
        self.assertEqual(render_reference(result).shape, self.reference.image.shape)
        self.assertFalse(np.array_equal(render_reference(result), self.reference.image))
        self.assertEqual(
            render_reference(result, result.pieces[0].piece.identifier).shape,
            self.reference.image.shape,
        )

    def test_perspective_mapping_error_below_three_pixels(self) -> None:
        crop = self.reference.image[130:330, 180:380]
        source = np.float32([[0, 0], [199, 0], [199, 199], [0, 199]])
        destination = np.float32([[30, 20], [240, 40], [230, 240], [40, 230]])
        to_photo = cv2.getPerspectiveTransform(source, destination)
        image = cv2.warpPerspective(crop, to_photo, (280, 270), borderValue=(45, 50, 45))
        mask = cv2.warpPerspective(
            np.full((200, 200), 255, np.uint8),
            to_photo,
            (280, 270),
            flags=cv2.INTER_NEAREST,
        )
        candidate = FeatureMatcher(self.reference.image).locate(image, mask)
        self.assertIsNotNone(candidate)
        projected = cv2.perspectiveTransform(destination[None], candidate.transform)[0]
        expected = source + (180, 130)
        self.assertLess(float(np.max(np.linalg.norm(projected - expected, axis=1))), 3)

    def test_unrelated_piece_does_not_get_a_feature_location(self) -> None:
        rng = np.random.default_rng(42)
        unrelated = rng.integers(0, 255, (100, 120, 3), dtype=np.uint8)
        self.assertIsNone(FeatureMatcher(self.reference.image).locate(unrelated))

    def test_failed_assembled_alignment_is_reported(self) -> None:
        image = np.full((240, 300, 3), 45, np.uint8)
        cv2.rectangle(image, (30, 30), (220, 190), (180, 130, 170), -1)
        result = analyze(
            self.reference,
            self.loose,
            Photo(image),
            Settings(template_fallback=False),
        )
        self.assertIsNone(result.occupied_mask)
        self.assertTrue(any("无法可靠对齐" in message for message in result.messages))
        self.assertTrue(all(piece.candidates for piece in result.pieces))

    def test_global_piece_limit(self) -> None:
        result = analyze(
            self.reference,
            self.loose * 2,
            settings=Settings(template_fallback=False, max_pieces=3),
        )
        self.assertEqual(len(result.pieces), 3)
        self.assertTrue(any("总碎片数超过" in message for message in result.messages))


class TemplateMatchingTests(unittest.TestCase):
    def test_masked_template_finds_known_position_within_five_pixels(self) -> None:
        rng = np.random.default_rng(13)
        reference = rng.integers(30, 225, (240, 320, 3), dtype=np.uint8)
        reference = cv2.GaussianBlur(reference, (0, 0), 1.8)
        piece = square_piece(64)
        piece.image = reference[70:134, 120:184].copy()
        candidates = template_candidates(piece, reference, Settings(approximate_columns=5))
        self.assertTrue(candidates)
        best = candidates[0]
        self.assertEqual(best.method, "template")
        self.assertFalse(best.reliable)
        self.assertLess(float(np.linalg.norm(np.subtract(best.center, (151.5, 101.5)))), 5)
        self.assertGreater(best.score, 0.9)
        self.assertLessEqual(len(candidates), 3)

    def test_constant_piece_has_no_meaningless_template_candidates(self) -> None:
        reference = np.full((240, 320, 3), 150, np.uint8)
        self.assertEqual(
            template_candidates(square_piece(64), reference, Settings(approximate_columns=5)),
            [],
        )


class EdgeAssessmentTests(unittest.TestCase):
    def test_complementary_tab_and_socket_fit_better_than_a_straight_edge(self) -> None:
        occupied = np.zeros((150, 200), np.uint8)
        occupied[35:95, 20:81] = 255
        cv2.circle(occupied, (80, 65), 12, 255, -1)
        socket_piece = square_piece(60)
        cv2.circle(socket_piece.mask, (-1, 30), 12, 0, -1)
        fitting = candidate_at(81, 35, 60)
        wrong_shape = candidate_at(81, 35, 60)
        assess_edges(fitting, socket_piece, occupied)
        assess_edges(wrong_shape, square_piece(60), occupied)
        self.assertEqual(fitting.overlap, 0)
        self.assertGreater(wrong_shape.overlap, 0.01)
        self.assertGreater(fitting.edge_score, wrong_shape.edge_score)
        self.assertGreater(fitting.priority, wrong_shape.priority)

    def test_adjacent_contour_has_support_and_overlap_is_penalized(self) -> None:
        occupied = np.zeros((120, 160), np.uint8)
        occupied[40:72, 25:60] = 255
        adjacent = candidate_at(60, 40)
        overlapping = candidate_at(42, 40)
        assess_edges(adjacent, square_piece(), occupied)
        assess_edges(overlapping, square_piece(), occupied)
        self.assertEqual(adjacent.overlap, 0)
        self.assertGreater(adjacent.contact, 0.2)
        self.assertGreater(adjacent.edge_score, 0.2)
        self.assertGreater(overlapping.overlap, 0.3)
        self.assertLess(overlapping.priority, adjacent.priority)
        self.assertEqual(overlapping.edge_score, 0)

    def test_nonadjacent_piece_has_no_edge_fit_score(self) -> None:
        occupied = np.zeros((120, 160), np.uint8)
        occupied[10:30, 10:30] = 255
        candidate = candidate_at(80, 60)
        assess_edges(candidate, square_piece(), occupied)
        self.assertEqual(candidate.overlap, 0)
        self.assertEqual(candidate.contact, 0)
        self.assertIsNone(candidate.edge_score)


class InputValidationTests(unittest.TestCase):
    def test_invalid_settings_are_rejected(self) -> None:
        for value in (0, 101):
            with self.assertRaises(ValueError):
                Settings(max_pieces=value)
        with self.assertRaises(ValueError):
            Settings(min_area_fraction=0)
        with self.assertRaises(ValueError):
            Settings(background_tolerance=0)
        with self.assertRaises(ValueError):
            Settings(approximate_columns=1)

    def test_at_least_one_loose_photo_is_required(self) -> None:
        with self.assertRaises(ValueError):
            analyze(Photo(np.zeros((200, 200, 3), np.uint8)), [])


if __name__ == "__main__":
    unittest.main()
