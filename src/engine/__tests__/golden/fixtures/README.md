# External fixture provenance

`nara-amendment-24-scan.jpg` is a downsampled scan of the Twenty-Fourth
Amendment from the United States National Archives and Records Administration
(NARA). The [NARA founding documents download page](https://www.archives.gov/founding-docs/downloads)
states that these images are in the public domain and requests credit to the
National Archives as the original source. The original image is available at
<https://www.archives.gov/files/founding-docs/downloads/24th_Amendment_Pg1of1_AC.jpg>.

- Original: 20,378,109 bytes, 5172 × 7778 pixels; SHA-256
  `ceb8290fd259163c6e85e213164051b9768bbb426c259fe833578c21db759788`.
- Derived JPEG: 508,711 bytes, 1596 × 2400 pixels; SHA-256
  `307fbf97f16965b4b74b03272312e93ce8615b2ed3460fe1adff3d4caf8c2170`.
- Transformation: using Node 20.20.2 and `@napi-rs/canvas` 0.1.100,
  decode the original JPEG, scale proportionally to 2400 pixels high with
  `imageSmoothingEnabled = true` and `imageSmoothingQuality = 'high'`, and
  encode a JPEG at quality 90. The derived image omits the original's metadata.

From the repository root with the original downloaded as `original.jpg`, the
transformation can be reproduced without changing the source image:

```sh
node -e 'const {createCanvas,loadImage}=require("@napi-rs/canvas"); const fs=require("node:fs"); (async()=>{const img=await loadImage(process.argv[1]); const width=Math.round(img.width*2400/img.height); const canvas=createCanvas(width,2400); const ctx=canvas.getContext("2d"); ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high"; ctx.drawImage(img,0,0,width,2400); fs.writeFileSync(process.argv[2],canvas.toBuffer("image/jpeg",90))})().catch(e=>{console.error(e);process.exitCode=1})' original.jpg derived.jpg
```

JPEG encoder results may vary across platform or library versions; the stored
fixture hash above is authoritative for tests.

The test wraps this image in a newly generated PDF. It is a real historical
scan, not an independently sourced PDF or an OCR reference; assertions about
text apply only to a synthetic text layer added by the test.

## IRS W-9 PDF

`irs-w9-2024.pdf` is the unmodified blank Form W-9 (March 2024 revision)
obtained on 2026-10-30 from the [IRS PDF](https://www.irs.gov/pub/irs-pdf/fw9.pdf),
linked by the [official form page](https://www.irs.gov/forms-pubs/about-form-w-9).
The IRS states that its publications may be reproduced and describes government
works and third-party copyright in its [forms guidance](https://www.irs.gov/irm/part21/irm_21-003-006)
and [copyright guidance](https://www.irs.gov/irm/part1/irm_01-017-008).
No copyright notice was found in the extracted text. The fixture is a blank
public government form and contains no taxpayer data.

- Size: 140,815 bytes; SHA-256
  `2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53`.
- Producer: Adobe Designer 6.5; six pages, XFA and an Adobe UR3 usage-rights
  signature. The PDF also contains JavaScript; tests do not execute it.
- OpenSSL validates the detached CMS signature over its ByteRange with
  `-noverify`; a changed signed byte fails. This checks cryptographic integrity,
  not certificate trust. Poppler `pdfsig` does not list this usage-rights
  signature, so its absence from that report is not proof the PDF is unsigned.
- The editor conservatively protects the signed original and does not support
  copying its XFA pages. This fixture is a protection/interoperability case,
  not a successful XFA editing or general signature-validation test.

## CC0 AcroForm samples

`cc0-sample-form.pdf` and `cc0-sample-form-filled.pdf` are unmodified blank and
prefilled synthetic test forms from
[tinytoolkit-org/pdf-sample-files](https://github.com/tinytoolkit-org/pdf-sample-files),
which identifies these exact files in its `out/` directory and applies
[CC0-1.0](https://github.com/tinytoolkit-org/pdf-sample-files/blob/master/LICENSE).
They were retrieved on 2026-10-30 from the author's
[form sample page](https://pdftoolskit.org/sample-pdf-with-form-fields); each
file was checked byte-for-byte by SHA-256 against the repository copy. Neither
contains real user data; both use standard Helvetica fonts without embedding
font programs.

- Blank form, 10,768 bytes: SHA-256
  `5a681d44622f2ee577808e77f034525314d48a628b9cad26f7788564c9e922e8`.
- Prefilled form, 12,038 bytes: SHA-256
  `17a5947607077aa0581cfc6c7f3158779b36b2c4c92e18cdeb9793bdbb2912fc`.

The author's generator uses pdf-lib, so the fixtures are independently
maintained synthetic forms, not independently authored real-world PDFs. They
cover nested field names and the stated text, multiline, checkbox, radio and
dropdown values; Poppler checks text in a saved copy, and pdf-lib verifies all
five changed field values. These tests do not establish general PDF form support.
