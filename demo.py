from __future__ import annotations

import cv2
import numpy as np

from puzzle_helper import Photo


def make_demo() -> tuple[Photo, Photo, list[tuple[str, Photo]]]:
    rng = np.random.default_rng(2026)
    height, width = 480, 640
    canvas = np.full((height, width, 3), (190, 205, 220), dtype=np.uint8)
    for _ in range(420):
        center = (int(rng.integers(10, width - 10)), int(rng.integers(10, height - 10)))
        color = tuple(int(value) for value in rng.integers(25, 225, 3))
        cv2.circle(canvas, center, int(rng.integers(2, 14)), color, -1, cv2.LINE_AA)
    for row in range(4):
        for column in range(5):
            cv2.putText(
                canvas,
                f"{row + 1}:{column + 1}",
                (column * 128 + 32, row * 120 + 68),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.85,
                (25, 30, 45),
                2,
                cv2.LINE_AA,
            )
    masks = []
    for row in range(4):
        for column in range(5):
            mask = np.zeros((height, width), dtype=np.uint8)
            x, y = column * 128, row * 120
            mask[y : y + 120, x : x + 128] = 255
            for edge, cx, cy in (
                ("right", x + 128, y + 60),
                ("left", x, y + 60),
                ("bottom", x + 64, y + 120),
                ("top", x + 64, y),
            ):
                if edge == "right" and column < 4:
                    cv2.circle(mask, (cx, cy), 17, 255, -1)
                elif edge == "left" and column > 0:
                    cv2.circle(mask, (cx, cy), 17, 0, -1)
                elif edge == "bottom" and row < 3:
                    cv2.circle(mask, (cx, cy), 15, 255, -1)
                elif edge == "top" and row > 0:
                    cv2.circle(mask, (cx, cy), 15, 0, -1)
            masks.append(mask)
    background = (45, 50, 45)
    assembled_mask = np.maximum.reduce([masks[index] for index in (0, 1, 5, 6, 10)])
    assembled = np.full((height + 60, width + 60, 3), background, dtype=np.uint8)
    view = assembled[30 : height + 30, 30 : width + 30]
    view[assembled_mask > 0] = canvas[assembled_mask > 0]
    loose = np.full((440, 640, 3), background, dtype=np.uint8)
    for index, (piece_index, angle) in enumerate(((2, 30), (7, 90), (11, 180), (14, 270))):
        mask = masks[piece_index]
        x, y, w, h = cv2.boundingRect(mask)
        patch = np.full((210, 210, 3), background, dtype=np.uint8)
        patch_mask = np.zeros((210, 210), dtype=np.uint8)
        left, top = (210 - w) // 2, (210 - h) // 2
        patch[top : top + h, left : left + w][mask[y : y + h, x : x + w] > 0] = (
            canvas[y : y + h, x : x + w][mask[y : y + h, x : x + w] > 0]
        )
        patch_mask[top : top + h, left : left + w] = mask[y : y + h, x : x + w]
        rotation = cv2.getRotationMatrix2D((105, 105), angle, 1)
        rotated = cv2.warpAffine(patch, rotation, (210, 210), borderValue=background)
        rotated_mask = cv2.warpAffine(
            patch_mask, rotation, (210, 210), flags=cv2.INTER_NEAREST
        )
        px, py = 35 + (index % 2) * 310, 5 + (index // 2) * 220
        target = loose[py : py + 210, px : px + 210]
        target[rotated_mask > 0] = rotated[rotated_mask > 0]
    return Photo(canvas), Photo(assembled), [("demo-pieces.png", Photo(loose))]
