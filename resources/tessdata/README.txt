Put eng.traineddata here before building the installer.

Download from:
  https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata

It must be bundled rather than fetched at runtime, or OCR of a scanned
certificate will fail on a machine with no internet. Roughly 23 MB.

If the file is missing, the app still works — the certificate upload falls
back to manual entry, which is the intended behaviour rather than an error.
