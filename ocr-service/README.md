# AuraScan OCR service

This service runs RapidOCR with ONNX Runtime. RapidOCR uses converted
PaddleOCR models, providing a lightweight self-hosted OCR stage before paid
Gemini fallbacks.

## Local use

```bash
python -m pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

Set `OCR_SERVICE_URL=http://127.0.0.1:8000` in `.env.local`.

It exposes `GET /health`, `POST /ocr-extract`, and `POST /detect-boxes`.
This optional service is not required for browser PaddleOCR.
