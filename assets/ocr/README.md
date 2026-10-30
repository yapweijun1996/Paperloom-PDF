# OCR language data

`eng.traineddata.gz` is the English integerized best model used by Tesseract.js
for its default LSTM worker. It is the unmodified file from
[`@tesseract.js-data/eng` version 1.0.0](https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz),
SHA-256 `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`.
The upstream [model documentation](https://github.com/naptha/tessdata) identifies
the source as Tesseract's tessdata_best; the [model data](https://github.com/tesseract-ocr/tessdata_best)
is distributed under Apache-2.0. See the project [LICENSE](../../LICENSE).

The build copies this model and the compatible Tesseract.js worker and LSTM core
variants from the locked npm dependencies into generated `public/ocr-assets/`.
They are served and cached from the application origin, including subpath builds.
