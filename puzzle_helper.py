from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from typing import Literal

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageOps


Pixels = NDArray[np.uint8]
Transform = NDArray[np.float64]
Background = Literal["auto", "light", "dark"]


@dataclass(frozen=True)
class Photo:
    image: Pixels
    alpha: Pixels | None = None


@dataclass(frozen=True)
class Settings:
    background: Background = "auto"
    background_tolerance: int = 32
    min_area_fraction: float = 0.002
    max_pieces: int = 40
    reference_max_side: int = 1600
    photo_max_side: int = 1800
    template_fallback: bool = True
    approximate_columns: int = 10

    def __post_init__(self) -> None:
        if self.background not in ("auto", "light", "dark"):
            raise ValueError("Unsupported background mode.")
        if not 5 <= self.background_tolerance <= 120:
            raise ValueError("Background tolerance must be between 5 and 120.")
        if not 0 < self.min_area_fraction < 0.5:
            raise ValueError("Minimum piece area must be between 0 and 0.5.")
        if not 1 <= self.max_pieces <= 100:
            raise ValueError("Maximum piece count must be between 1 and 100.")
        if min(self.reference_max_side, self.photo_max_side) < 200:
            raise ValueError("Working image dimensions must be at least 200.")
        if not 2 <= self.approximate_columns <= 100:
            raise ValueError("Approximate column count must be between 2 and 100.")


@dataclass
class Piece:
    identifier: str
    source: str
    image: Pixels
    mask: Pixels
    contour: NDArray[np.int32]
    bounds: tuple[int, int, int, int]


@dataclass
class Candidate:
    transform: Transform
    polygon: NDArray[np.float32]
    score: float
    method: Literal["features", "template"]
    inliers: int = 0
    reliable: bool = False
    overlap: float | None = None
    contact: float | None = None
    edge_score: float | None = None

    @property
    def center(self) -> tuple[float, float]:
        point = self.polygon.mean(axis=0)
        return float(point[0]), float(point[1])

    @property
    def priority(self) -> float:
        if self.overlap is None:
            return self.score
        edge = self.edge_score if self.edge_score is not None else 0.0
        contact = min(1.0, (self.contact or 0.0) * 4.0)
        return self.score * 0.7 + contact * 0.2 + edge * 0.1 - self.overlap * 0.7


@dataclass
class PieceResult:
    piece: Piece
    candidates: list[Candidate] = field(default_factory=list)


@dataclass
class Analysis:
    reference: Pixels
    pieces: list[PieceResult]
    source_previews: dict[str, Pixels]
    occupied_mask: Pixels | None
    messages: list[str]


def load_photo(data: bytes) -> Photo:
    if not data:
        raise ValueError("图片文件为空。")
    with Image.open(BytesIO(data)) as original:
        if original.width * original.height > 30_000_000:
            raise ValueError("图片超过 3000 万像素，请先缩小后再上传。")
        rgba = np.asarray(ImageOps.exif_transpose(original).convert("RGBA"))
    alpha = rgba[:, :, 3].copy()
    rgb = rgba[:, :, :3].astype(np.float32)
    opacity = alpha[:, :, None].astype(np.float32) / 255.0
    rgb = np.rint(rgb * opacity + 255 * (1 - opacity)).astype(np.uint8)
    return Photo(
        cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
        alpha if np.any(alpha < 255) else None,
    )


def resize_photo(photo: Photo, max_side: int) -> Photo:
    height, width = photo.image.shape[:2]
    if max(height, width) <= max_side:
        return photo
    scale = max_side / max(height, width)
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    image = cv2.resize(photo.image, size, interpolation=cv2.INTER_AREA)
    alpha = (
        cv2.resize(photo.alpha, size, interpolation=cv2.INTER_NEAREST)
        if photo.alpha is not None
        else None
    )
    return Photo(image, alpha)


def foreground_mask(
    photo: Photo, settings: Settings, *, fill_holes: bool = True
) -> Pixels:
    if photo.alpha is not None:
        mask = np.where(photo.alpha > 32, 255, 0).astype(np.uint8)
    else:
        lab = cv2.cvtColor(photo.image, cv2.COLOR_BGR2LAB).astype(np.float32)
        if settings.background == "auto":
            border = np.concatenate((lab[0], lab[-1], lab[:, 0], lab[:, -1]))
            background = np.median(border, axis=0)
        else:
            value = 255 if settings.background == "light" else 0
            sample = np.full((1, 1, 3), value, dtype=np.uint8)
            background = cv2.cvtColor(sample, cv2.COLOR_BGR2LAB)[0, 0]
        distance = np.linalg.norm(lab - background, axis=2)
        mask = np.where(distance > settings.background_tolerance, 255, 0).astype(
            np.uint8
        )
        kernel = np.ones((3, 3), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    if not fill_holes:
        return mask
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 255, cv2.FILLED)
    return filled


def extract_pieces(
    photo: Photo, source: str, prefix: str, settings: Settings
) -> tuple[list[Piece], Pixels, list[str]]:
    mask = foreground_mask(photo, settings)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    minimum = mask.size * settings.min_area_fraction
    contours = sorted(
        (contour for contour in contours if cv2.contourArea(contour) >= minimum),
        key=lambda contour: (cv2.boundingRect(contour)[1], cv2.boundingRect(contour)[0]),
    )
    messages: list[str] = []
    if len(contours) > settings.max_pieces:
        messages.append(
            f"{source}：检测到 {len(contours)} 个区域，只处理前 {settings.max_pieces} 个；"
            "请分批拍照或提高最小面积。"
        )
    pieces: list[Piece] = []
    preview = photo.image.copy()
    height, width = mask.shape
    for index, contour in enumerate(contours[: settings.max_pieces], 1):
        x, y, w, h = cv2.boundingRect(contour)
        if x <= 1 or y <= 1 or x + w >= width - 1 or y + h >= height - 1:
            messages.append(
                f"{source}：有区域接触照片边缘，已跳过。请让碎片四周都露出背景。"
            )
            continue
        local_mask = np.zeros((h, w), dtype=np.uint8)
        local_contour = contour - np.array([[[x, y]]], dtype=np.int32)
        cv2.drawContours(local_mask, [local_contour], -1, 255, cv2.FILLED)
        identifier = f"{prefix}-{index:02d}"
        pieces.append(
            Piece(
                identifier,
                source,
                photo.image[y : y + h, x : x + w].copy(),
                local_mask,
                local_contour,
                (x, y, w, h),
            )
        )
        cv2.drawContours(preview, [contour], -1, (0, 180, 255), 2)
        cv2.putText(
            preview,
            identifier,
            (x, max(20, y - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (10, 70, 220),
            2,
            cv2.LINE_AA,
        )
    if not pieces:
        messages.append(
            f"{source}：没有分离出可用碎片。请换用反差明显的纯色背景，"
            "确保碎片不接触，并调整背景容差或最小面积。"
        )
    return pieces, preview, messages


def _corners(image: Pixels) -> NDArray[np.float32]:
    h, w = image.shape[:2]
    return np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)


def _valid_polygon(
    polygon: NDArray[np.float32], reference: Pixels
) -> bool:
    if not np.isfinite(polygon).all() or not cv2.isContourConvex(polygon):
        return False
    area = cv2.contourArea(polygon)
    height, width = reference.shape[:2]
    if not width * height * 0.0001 <= area <= width * height * 1.15:
        return False
    lengths = np.linalg.norm(polygon - np.roll(polygon, 1, axis=0), axis=1)
    if lengths.min() < 5 or lengths.max() / lengths.min() > 12:
        return False
    intersection, _ = cv2.intersectConvexConvex(polygon, _corners(reference))
    return intersection / area >= 0.88


class FeatureMatcher:
    def __init__(self, reference: Pixels) -> None:
        self.reference = reference
        self.detector = cv2.SIFT_create(nfeatures=7000, contrastThreshold=0.025)
        self.keypoints, self.descriptors = self.detector.detectAndCompute(
            cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY), None
        )

    def locate(self, image: Pixels, mask: Pixels | None = None) -> Candidate | None:
        if self.descriptors is None or len(self.descriptors) < 2:
            return None
        feature_mask = (
            cv2.erode(mask, np.ones((5, 5), np.uint8)) if mask is not None else None
        )
        keypoints, descriptors = self.detector.detectAndCompute(
            cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), feature_mask
        )
        if descriptors is None or len(descriptors) < 4:
            return None
        neighbors = cv2.BFMatcher().knnMatch(descriptors, self.descriptors, k=2)
        good = [
            pair[0]
            for pair in neighbors
            if len(pair) == 2 and pair[0].distance < 0.72 * pair[1].distance
        ]
        # A reference feature cannot count as multiple independent correspondences.
        unique = {}
        for match in sorted(good, key=lambda match: match.distance):
            unique.setdefault(match.trainIdx, match)
        good = list(unique.values())
        if len(good) < 4:
            return None
        source = np.float32([keypoints[m.queryIdx].pt for m in good])
        target = np.float32([self.keypoints[m.trainIdx].pt for m in good])
        threshold = max(2.5, max(self.reference.shape[:2]) * 0.002)
        if len(good) >= 8:
            transform, accepted = cv2.findHomography(
                source, target, cv2.RANSAC, threshold, maxIters=3000
            )
        else:
            affine, accepted = cv2.estimateAffinePartial2D(
                source, target, method=cv2.RANSAC, ransacReprojThreshold=threshold
            )
            transform = np.vstack((affine, [0, 0, 1])) if affine is not None else None
        if transform is None or accepted is None:
            return None
        selected = accepted.ravel().astype(bool)
        count = int(selected.sum())
        ratio = count / len(good)
        if count < (6 if len(good) >= 8 else 4) or ratio < 0.45:
            return None
        source_polygon = _corners(image)
        if mask is not None:
            x, y, width, height = cv2.boundingRect(mask)
            source_polygon = np.float32(
                [[x, y], [x + width - 1, y], [x + width - 1, y + height - 1], [x, y + height - 1]]
            )
        polygon = cv2.perspectiveTransform(source_polygon[None], transform)[0]
        if not _valid_polygon(polygon, self.reference):
            return None
        coverage = cv2.contourArea(cv2.convexHull(source[selected])) / (
            image.shape[0] * image.shape[1]
        )
        if coverage < 0.025:
            return None
        projected = cv2.perspectiveTransform(source[None], transform)[0]
        error = float(np.median(np.linalg.norm(projected[selected] - target[selected], axis=1)))
        score = (
            0.45 * min(count / 15, 1)
            + 0.3 * ratio
            + 0.25 * np.exp(-error / threshold)
        )
        return Candidate(
            transform,
            polygon,
            float(np.clip(score, 0, 1)),
            "features",
            count,
            count >= 8 and coverage >= 0.06 and error <= threshold,
        )


def _rotate_template(
    image: Pixels, mask: Pixels, angle: int, scale: float
) -> tuple[Pixels, Pixels, Transform]:
    height, width = image.shape[:2]
    affine = cv2.getRotationMatrix2D(((width - 1) / 2, (height - 1) / 2), angle, scale)
    cosine, sine = abs(affine[0, 0]), abs(affine[0, 1])
    out_width = max(1, int(np.ceil(width * cosine + height * sine)))
    out_height = max(1, int(np.ceil(height * cosine + width * sine)))
    affine[0, 2] += (out_width - width) / 2
    affine[1, 2] += (out_height - height) / 2
    size = (out_width, out_height)
    rotated = cv2.warpAffine(image, affine, size, flags=cv2.INTER_LINEAR)
    rotated_mask = cv2.warpAffine(mask, affine, size, flags=cv2.INTER_NEAREST)
    return rotated, rotated_mask, np.vstack((affine, [0, 0, 1]))


def template_candidates(
    piece: Piece, reference: Pixels, settings: Settings
) -> list[Candidate]:
    # Bounded search: 12 rotations, 5 scales, and a reference no larger than 640 px.
    factor = min(1.0, 640 / max(reference.shape[:2]))
    small = cv2.resize(reference, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    target_width = small.shape[1] / settings.approximate_columns
    base_scale = target_width / max(piece.image.shape[:2])
    pool: list[Candidate] = []
    for angle in range(0, 360, 30):
        for multiplier in (0.75, 0.9, 1.0, 1.2, 1.4):
            template, mask, transform = _rotate_template(
                piece.image, piece.mask, angle, base_scale * multiplier
            )
            h, w = template.shape[:2]
            if min(h, w) < 8 or h >= small.shape[0] or w >= small.shape[1]:
                continue
            active = mask > 0
            if int(active.sum()) < 50:
                continue
            # Masked, mean-centered color correlation avoids favoring blank white areas.
            weights = active.astype(np.float32)
            count = float(weights.sum())
            score_map = np.zeros(
                (small.shape[0] - h + 1, small.shape[1] - w + 1), np.float32
            )
            template_energy = 0.0
            window_energy = np.zeros_like(score_map)
            for channel in range(3):
                values = template[:, :, channel].astype(np.float32)
                centered = (values - float(values[active].mean())) * weights
                template_energy += float(np.sum(centered * centered))
                reference_channel = small[:, :, channel].astype(np.float32)
                score_map += cv2.matchTemplate(
                    reference_channel, centered, cv2.TM_CCORR
                )
                sums = cv2.matchTemplate(reference_channel, weights, cv2.TM_CCORR)
                squares = cv2.matchTemplate(
                    reference_channel * reference_channel, weights, cv2.TM_CCORR
                )
                window_energy += np.maximum(squares - sums * sums / count, 0)
            if template_energy / count < 20:
                continue
            denominator = np.sqrt(template_energy * np.maximum(window_energy, 0))
            correlation = np.full_like(score_map, -1)
            np.divide(score_map, denominator, out=correlation, where=denominator > 1)
            correlation = np.clip(correlation, -1, 1)
            for _ in range(2):
                _, best, _, location = cv2.minMaxLoc(correlation)
                if best < 0.42:
                    break
                x, y = location
                placed = transform.copy()
                placed[0, 2] += x
                placed[1, 2] += y
                placed[:2] /= factor
                polygon = cv2.perspectiveTransform(_corners(piece.image)[None], placed)[0]
                if _valid_polygon(polygon, reference):
                    pool.append(
                        Candidate(placed, polygon, float(best), "template")
                    )
                radius = max(8, min(h, w) // 2)
                correlation[
                    max(0, y - radius) : y + radius + 1,
                    max(0, x - radius) : x + radius + 1,
                ] = -1
    selected: list[Candidate] = []
    for candidate in sorted(pool, key=lambda item: item.score, reverse=True):
        if all(
            np.linalg.norm(np.subtract(candidate.center, other.center))
            > max(12, np.sqrt(cv2.contourArea(candidate.polygon)) * 0.5)
            for other in selected
        ):
            selected.append(candidate)
        if len(selected) == 3:
            break
    return selected


def assess_edges(candidate: Candidate, piece: Piece, occupied: Pixels) -> None:
    height, width = occupied.shape
    mask = cv2.warpPerspective(
        piece.mask, candidate.transform, (width, height), flags=cv2.INTER_NEAREST
    )
    area = int(np.count_nonzero(mask))
    if not area:
        return
    radius = max(2, round(np.sqrt(area) * 0.035))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1,) * 2)
    occupied_core = cv2.erode(occupied, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)
    candidate.overlap = float(np.count_nonzero((mask > 0) & (occupied_core > 0)) / area)
    boundary = cv2.subtract(mask, cv2.erode(mask, np.ones((3, 3), np.uint8)))
    occupied_boundary = cv2.subtract(
        occupied, cv2.erode(occupied, np.ones((3, 3), np.uint8))
    )
    distance = cv2.distanceTransform(255 - occupied_boundary, cv2.DIST_L2, 3)
    perimeter = boundary > 0
    nearby = perimeter & (distance <= radius * 3)
    candidate.contact = float(np.count_nonzero(nearby) / max(1, np.count_nonzero(perimeter)))
    if candidate.contact >= 0.04:
        fit = float(np.mean(np.exp(-distance[nearby] / radius)))
        candidate.edge_score = fit * max(0, 1 - candidate.overlap * 5)


def analyze(
    reference: Photo,
    loose_photos: list[tuple[str, Photo]],
    assembled: Photo | None = None,
    settings: Settings | None = None,
) -> Analysis:
    settings = settings or Settings()
    if not loose_photos:
        raise ValueError("至少需要一张散片照片。")
    reference = resize_photo(reference, settings.reference_max_side)
    matcher = FeatureMatcher(reference.image)
    messages: list[str] = []
    occupied: Pixels | None = None
    if matcher.descriptors is None:
        messages.append("参考图纹理不足，无法进行特征定位；纯色和重复图案可能没有唯一答案。")
    if assembled is not None:
        assembled = resize_photo(assembled, settings.photo_max_side)
        assembled_mask = foreground_mask(assembled, settings, fill_holes=False)
        fraction = np.count_nonzero(assembled_mask) / assembled_mask.size
        if not 0.005 < fraction < 0.95:
            messages.append(
                "已拼区域的背景分离失败，已停用轮廓检查。请让已拼区域周围露出纯色背景。"
            )
        else:
            alignment = matcher.locate(assembled.image, assembled_mask)
            if alignment is None or not alignment.reliable:
                messages.append(
                    "已拼区域无法可靠对齐，已停用轮廓检查；散片仍可按图案定位。"
                )
            else:
                h, w = reference.image.shape[:2]
                occupied = cv2.warpPerspective(
                    assembled_mask,
                    alignment.transform,
                    (w, h),
                    flags=cv2.INTER_NEAREST,
                )
    results: list[PieceResult] = []
    previews: dict[str, Pixels] = {}
    for photo_index, (name, photo) in enumerate(loose_photos, 1):
        photo = resize_photo(photo, settings.photo_max_side)
        pieces, preview, notes = extract_pieces(photo, name, str(photo_index), settings)
        messages.extend(notes)
        previews[f"{photo_index}. {name}"] = preview
        if len(results) + len(pieces) > settings.max_pieces:
            messages.append(
                f"总碎片数超过 {settings.max_pieces}，超出部分未处理。请将照片分批分析。"
            )
            pieces = pieces[: max(0, settings.max_pieces - len(results))]
        for piece in pieces:
            match = matcher.locate(piece.image, piece.mask)
            candidates = [match] if match is not None else []
            if not candidates and settings.template_fallback:
                candidates = template_candidates(piece, reference.image, settings)
            if occupied is not None:
                for candidate in candidates:
                    assess_edges(candidate, piece, occupied)
                candidates.sort(key=lambda item: item.priority, reverse=True)
            results.append(PieceResult(piece, candidates))
    return Analysis(reference.image, results, previews, occupied, messages)


def render_reference(
    analysis: Analysis, selected_id: str | None = None, candidate_index: int = 0
) -> Pixels:
    image = analysis.reference.copy()
    if analysis.occupied_mask is not None:
        active = analysis.occupied_mask > 0
        tint = np.full_like(image, (80, 175, 80))
        image[active] = cv2.addWeighted(image, 0.7, tint, 0.3, 0)[active]
    for result in analysis.pieces:
        if selected_id is not None and result.piece.identifier != selected_id:
            continue
        if not result.candidates:
            continue
        candidate = result.candidates[min(candidate_index, len(result.candidates) - 1)]
        contour = cv2.perspectiveTransform(
            result.piece.contour.astype(np.float32), candidate.transform
        ).round().astype(np.int32)
        color = (40, 170, 20) if candidate.reliable else (0, 155, 255)
        if candidate.overlap is not None and candidate.overlap > 0.2:
            color = (40, 40, 230)
        cv2.polylines(image, [contour], True, color, 3, cv2.LINE_AA)
        x, y = (round(value) for value in candidate.center)
        cv2.putText(
            image,
            result.piece.identifier,
            (max(0, x - 20), max(20, y)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            color,
            2,
            cv2.LINE_AA,
        )
    return image


def export_results(analysis: Analysis) -> dict[str, object]:
    height, width = analysis.reference.shape[:2]
    return {
        "reference_size": {"width": width, "height": height},
        "coordinate_system": "resized_reference_pixels, origin=top_left",
        "scores_are_probabilities": False,
        "messages": analysis.messages,
        "pieces": [
            {
                "id": result.piece.identifier,
                "source": result.piece.source,
                "candidates": [
                    {
                        "method": candidate.method,
                        "score": round(candidate.score, 4),
                        "reliable_features": candidate.reliable,
                        "inliers": candidate.inliers,
                        "center": list(candidate.center),
                        "corners": candidate.polygon.tolist(),
                        "transform": candidate.transform.tolist(),
                        "occupied_overlap": candidate.overlap,
                        "boundary_contact": candidate.contact,
                        "edge_fit": candidate.edge_score,
                    }
                    for candidate in result.candidates
                ],
            }
            for result in analysis.pieces
        ],
    }
