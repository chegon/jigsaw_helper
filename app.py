from __future__ import annotations

import json
from io import BytesIO

import cv2
import streamlit as st
from PIL import Image, UnidentifiedImageError

from demo import make_demo
from puzzle_helper import (
    Analysis,
    Candidate,
    Settings,
    analyze,
    export_results,
    load_photo,
    render_reference,
)


st.set_page_config(page_title="拼图定位助手", page_icon="🧩", layout="wide")
st.title("🧩 拼图定位助手")
st.write("参考图找图案，已拼区域核对边缘。所有图片均在运行此程序的本机处理。")
st.caption("这是辅助定位原型，不保证唯一解；纯色、重复图案、反光和模糊照片尤其需要人工核对。")

with st.sidebar:
    st.header("识别设置")
    use_demo = st.checkbox("使用内置演示图片", value=False)
    background_label = st.selectbox("拍摄背景", ["自动（采样照片边缘）", "白色 / 浅色", "黑色 / 深色"])
    tolerance = st.slider("背景分离容差", 5, 100, 32)
    area_percent = st.slider("单片最小面积（占照片 %）", 0.05, 3.0, 0.2, 0.05)
    max_pieces = st.number_input("最多处理碎片数", 1, 100, 40)
    fallback = st.checkbox("启用较慢的弱纹理候选搜索", value=True)
    columns = st.number_input(
        "整幅拼图横向约有几片",
        2,
        100,
        5 if use_demo else 10,
        help="只用于弱纹理候选搜索的尺寸估计。数值偏差过大会漏掉正确位置。",
    )
    st.caption("弱纹理搜索每片最多尝试 12 个角度 × 5 种尺寸，只提供待核对候选。")
    st.info("拍摄建议：纯色且与碎片反差明显的桌面；散片互不接触；四周留白；尽量正上方拍摄。")

uploads = st.columns(3)
with uploads[0]:
    reference_file = st.file_uploader(
        "1. 完整参考图（必选）",
        type=["jpg", "jpeg", "png", "webp"],
        disabled=use_demo,
    )
    st.caption("拼图正面完整图案，尽量裁掉包装盒边框。")
with uploads[1]:
    assembled_file = st.file_uploader(
        "2. 已拼区域（可选）",
        type=["jpg", "jpeg", "png", "webp"],
        disabled=use_demo,
    )
    st.caption("用于判断相邻轮廓和重叠；对齐失败时只按图案定位。")
with uploads[2]:
    loose_files = st.file_uploader(
        "3. 散片照片（必选，可多张）",
        type=["jpg", "jpeg", "png", "webp"],
        accept_multiple_files=True,
        disabled=use_demo,
    )
    st.caption("每张可包含多块分开的碎片；透明背景 PNG 也可以。")


def describe(candidate: Candidate) -> str:
    if candidate.overlap is not None and candidate.overlap > 0.2:
        return "与已拼区域重叠，请核对"
    if candidate.reliable:
        if candidate.edge_score is not None and candidate.edge_score >= 0.45:
            return "图案匹配，邻接轮廓有支持"
        return "图案特征匹配"
    return "待人工核对的候选"


def png_bytes(image) -> bytes:
    output = BytesIO()
    Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)).save(output, format="PNG")
    return output.getvalue()


settings = Settings(
    background={
        "自动（采样照片边缘）": "auto",
        "白色 / 浅色": "light",
        "黑色 / 深色": "dark",
    }[background_label],
    background_tolerance=tolerance,
    min_area_fraction=area_percent / 100,
    max_pieces=int(max_pieces),
    template_fallback=fallback,
    approximate_columns=int(columns),
)
signature = (
    use_demo,
    reference_file.getvalue() if reference_file else None,
    assembled_file.getvalue() if assembled_file else None,
    tuple((file.name, file.getvalue()) for file in loose_files),
    settings,
)
if st.session_state.get("input_signature") != signature:
    st.session_state.pop("analysis", None)
    st.session_state["input_signature"] = signature

ready = use_demo or (reference_file is not None and bool(loose_files))
if st.button("开始分析", type="primary", disabled=not ready):
    st.session_state.pop("analysis", None)
    try:
        if use_demo:
            reference, assembled, loose = make_demo()
        else:
            reference = load_photo(reference_file.getvalue())
            assembled = load_photo(assembled_file.getvalue()) if assembled_file else None
            loose = [(file.name, load_photo(file.getvalue())) for file in loose_files]
        with st.spinner("正在分离碎片、匹配图案并检查轮廓……"):
            st.session_state["analysis"] = analyze(reference, loose, assembled, settings)
    except (ValueError, UnidentifiedImageError, OSError, Image.DecompressionBombError, cv2.error) as error:
        st.error(f"分析失败：{error}")

if not ready:
    st.info("上传完整参考图和至少一张散片照片，或勾选侧栏的“使用内置演示图片”。")

if "analysis" in st.session_state:
    analysis: Analysis = st.session_state["analysis"]
    for message in analysis.messages:
        st.warning(message)
    located = [result for result in analysis.pieces if result.candidates]
    strong = sum(result.candidates[0].reliable for result in located)
    metrics = st.columns(3)
    metrics[0].metric("分离出的碎片", len(analysis.pieces))
    metrics[1].metric("有候选位置", len(located))
    metrics[2].metric("可靠图案特征匹配", strong)
    st.caption(
        "绿色轮廓：可靠图案特征；橙色：待核对候选；红色：与已拼区域冲突；"
        "绿色半透明区域：已拼区域。评分是相对匹配分，不是正确概率。"
    )
    overview_tab, detail_tab, segmentation_tab = st.tabs(["定位总览", "逐片核对", "散片编号"])
    with overview_tab:
        overview = render_reference(analysis)
        st.image(overview, channels="BGR", caption="候选在完整参考图上的位置", width="stretch")
        if located:
            st.subheader("优先核对")
            ranked = sorted(
                located, key=lambda result: result.candidates[0].priority, reverse=True
            )
            rows = []
            for result in ranked:
                candidate = result.candidates[0]
                x, y = candidate.center
                rows.append(
                    {
                        "碎片编号": result.piece.identifier,
                        "来源照片": result.piece.source,
                        "状态": describe(candidate),
                        "图案分 / 100": round(candidate.score * 100),
                        "特征内点": candidate.inliers,
                        "参考图中心 (x, y)": f"({x:.0f}, {y:.0f})",
                        "邻接轮廓分 / 100": (
                            round(candidate.edge_score * 100)
                            if candidate.edge_score is not None
                            else None
                        ),
                        "已拼重叠": (
                            f"{candidate.overlap:.0%}"
                            if candidate.overlap is not None
                            else "未启用"
                        ),
                    }
                )
            st.dataframe(
                rows,
                hide_index=True,
                width="stretch",
                column_config={
                    "邻接轮廓分 / 100": st.column_config.NumberColumn(
                        help="空白表示没有可比较的邻接轮廓。", format="%d"
                    )
                },
            )
        else:
            st.warning("暂时没有可用位置。请先检查“散片编号”中的分割效果，再改善照片或调整参数。")
        download_columns = st.columns(2)
        download_columns[0].download_button(
            "下载定位图 PNG",
            png_bytes(overview),
            file_name="puzzle-locations.png",
            mime="image/png",
        )
        download_columns[1].download_button(
            "下载候选坐标 JSON",
            json.dumps(export_results(analysis), ensure_ascii=False, indent=2, allow_nan=False),
            file_name="puzzle-candidates.json",
            mime="application/json",
        )
        st.caption(
            f"导出坐标基于缩放后的参考图：{analysis.reference.shape[1]} × "
            f"{analysis.reference.shape[0]} 像素；原点在左上角。"
        )
    with detail_tab:
        if analysis.pieces:
            identifiers = [result.piece.identifier for result in analysis.pieces]
            selected = st.selectbox("选择碎片编号", identifiers)
            result = next(item for item in analysis.pieces if item.piece.identifier == selected)
            left, right = st.columns([1, 3])
            with left:
                thumbnail = result.piece.image.copy()
                thumbnail[result.piece.mask == 0] = 245
                st.image(thumbnail, channels="BGR", caption=f"{selected} · {result.piece.source}")
            with right:
                if result.candidates:
                    candidate_number = st.radio(
                        "候选位置",
                        range(len(result.candidates)),
                        format_func=lambda value: f"候选 {value + 1}",
                        horizontal=True,
                        key=f"candidate-{selected}",
                    )
                    candidate = result.candidates[candidate_number]
                    st.write(describe(candidate))
                    st.image(
                        render_reference(analysis, selected, candidate_number),
                        channels="BGR",
                        width="stretch",
                    )
                else:
                    st.warning("这块碎片没有可验证的位置。可尝试更清晰照片，或启用弱纹理候选搜索。")
        else:
            st.info("未分离出碎片。")
    with segmentation_tab:
        for name, preview in analysis.source_previews.items():
            st.image(preview, channels="BGR", caption=name, width="stretch")
        st.caption("粘在一起的碎片会被当作一块。若编号错误，请先分开碎片重新拍照。")

with st.expander("原理与限制"):
    st.markdown(
        """
1. 从纯色背景或透明通道提取每块碎片的真实轮廓，并给照片编号。
2. 用 SIFT 特征、比率检验和 RANSAC 几何验证，估计散片在完整图中的位置、旋转和缩放。
3. 特征不足时，尝试有遮罩的多角度、多尺寸颜色相关搜索；结果始终标为待核对。
4. 已拼照片能够可靠对齐时，将其轮廓映射到参考图，检查候选是否重叠、邻边是否接近。

**完整图通常没有切割线，不能单凭它推断每块的凹凸形状。**
轮廓分只能为邻接位置提供辅助证据，不是独立的拼合证明。
本版不自动分开相互接触的碎片，不适合严重透视、反光、纯色或大量重复图案。
        """
    )
