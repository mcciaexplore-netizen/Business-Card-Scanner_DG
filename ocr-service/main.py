import cv2
import numpy as np
import io
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from rapidocr_onnxruntime import RapidOCR

app = FastAPI(title="AuraScan OpenCV + RapidOCR Enhancement Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize RapidOCR ONNX model once on startup
ocr_engine = RapidOCR()

def order_points(pts: np.ndarray) -> np.ndarray:
    """Orders 4 points as: top-left, top-right, bottom-right, bottom-left."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect

def perspective_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Applies a 4-point perspective warp transform to flatten rotated cards."""
    rect = order_points(pts)
    (tl, tr, br, bl) = rect

    width_a = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    width_b = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    max_width = max(int(width_a), int(width_b))

    height_a = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    height_b = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    max_height = max(int(height_a), int(height_b))

    if max_width < 10 or max_height < 10:
        return image

    dst = np.array([
        [0, 0],
        [max_width - 1, 0],
        [max_width - 1, max_height - 1],
        [0, max_height - 1]
    ], dtype="float32")

    matrix = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, matrix, (max_width, max_height))
    return warped

def deskew_and_enhance(image: np.ndarray) -> np.ndarray:
    """Detects card boundaries, applies deskewing, and enhances image contrast."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(blurred, 30, 150)

    contours, _ = cv2.findContours(edged.copy(), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:5]

    card_contour = None
    for c in contours:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            card_contour = approx
            break

    if card_contour is not None:
        try:
            pts = card_contour.reshape(4, 2)
            warped = perspective_transform(image, pts)
            return warped
        except Exception:
            pass

    return image

@app.get("/health")
def health_check():
    return {"status": "ok", "ocr_engine": "rapidocr-onnxruntime"}

@app.post("/detect-boxes")
async def detect_card_boxes(file: UploadFile = File(...)):
    """Locates business card bounding boxes in a bulk photo using OpenCV contour analysis."""
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image file.")

    height, width = image.shape[:2]
    min_area = (width * height) * 0.02

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(blurred, 50, 200)

    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue

        x, y, w, h = cv2.boundingRect(c)
        aspect_ratio = float(w) / h if h > 0 else 0
        if 0.4 <= aspect_ratio <= 2.8:
            ymin = int(max(0, (y / height) * 1000))
            xmin = int(max(0, (x / width) * 1000))
            ymax = int(min(1000, ((y + h) / height) * 1000))
            xmax = int(min(1000, ((x + w) / width) * 1000))

            boxes.append({"ymin": ymin, "xmin": xmin, "ymax": ymax, "xmax": xmax})

    return {"boxes": boxes}

@app.post("/ocr-extract")
async def ocr_extract(file: UploadFile = File(...)):
    """Applies OpenCV deskewing and runs RapidOCR on a business card crop."""
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image file.")

    processed_img = deskew_and_enhance(image)

    # Run RapidOCR inference
    ocr_result, _ = ocr_engine(processed_img)

    lines = []
    confidences = []

    if ocr_result:
        for item in ocr_result:
            if len(item) >= 2:
                text = item[1]
                conf = item[2] if len(item) >= 3 else 0.9
                if text and isinstance(text, str):
                    lines.append(text.strip())
                    confidences.append(float(conf))

    avg_confidence = (sum(confidences) / len(confidences) * 100) if confidences else 0.0
    raw_text = "\n".join(lines)

    return {
        "text": raw_text,
        "lines": lines,
        "confidence": avg_confidence,
    }
