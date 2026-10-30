# Bundled font inventory

These files are distributed in `public/fonts`. Copyright lines below are copied
from the accompanying license files. Provenance of the JP, KR and TC assets
is recorded below; the upstream download URL and acquisition date of the other
binaries have not been established. The SHA-256 hashes identify the files currently in this checkout.
Each referenced license file contains its full terms.

| Font | License file | SHA-256 | Attribution from license file |
| --- | --- | --- | --- |
| `NotoSans-Regular.ttf` | `NotoSans-OFL.txt` | eb9f291713e193ddd2bcf7c216ebd79ecf6b4346486c49184f4af15d9bd6c62e | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |
| `NotoSansBengali-Regular.ttf` | `NotoSansBengali-OFL.txt` | e3f00a7eaff61bb3b831c3863a82a083667011bb5fec66d1a23d73cb5b90f447 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/bengali) |
| `NotoSansDevanagari-Regular.ttf` | `NotoSansDevanagari-OFL.txt` | 1f5f6dbc2a8eed98098ac70cfa5c19f0d7d61bab032540beeac4f72b5fa3aba1 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari) |
| `NotoSansGujarati-Regular.ttf` | `NotoSansGujarati-OFL.txt` | 3139293ec33c8b3c36be3915593687ddb500ba929ca61205f8b36b99ecf5b11c | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gujarati) |
| `NotoSansGurmukhi-Regular.ttf` | `NotoSansGurmukhi-OFL.txt` | efbc06964895f6b7d60f8ff5b31870607e830826d1407a152d5e65b5bc092d76 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gurmukhi) |
| `NotoSansJP-Regular.ttf` | `NotoSansJP-OFL.txt` | 1b103887faab2ab66e650311e333fbc3c945ceb0b86ea20ac3ec3071aea6895b | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' |
| `NotoSansKR-Regular.ttf` | `NotoSansKR-OFL.txt` | 603d7a9a21c5f4bb2fc79e1651923f014c113a576219c04c23b752cca32d6f81 | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' |
| `NotoSansKannada-Regular.ttf` | `NotoSansKannada-OFL.txt` | 779da27ff16ce158ea03603eae3fb90682937594850424baca115661d8a6605d | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/kannada) |
| `NotoSansMalayalam-Regular.ttf` | `NotoSansMalayalam-OFL.txt` | 4f04b3be9ed854ed54a745ee0541b4b8d86e12be3775b7e25111abe62b45aaa4 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/malayalam) |
| `NotoSansSC-Regular.ttf` | `NotoSansSC-OFL.txt` | d45f67f0a7c0ca3f256950777ce6a61cc7ce5f9696d02900cbbaac25f8aa7d16 | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' |
| `NotoSansTC-Regular.ttf` | `NotoSansTC-OFL.txt` | d3e92454e39c73421f3fdfb657361cdd549bc0977f10f440537b6adf171bac9f | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' |
| `NotoSansTamil-Regular.ttf` | `NotoSansTamil-OFL.txt` | b4a45c2812b07fe5f4af00c5af51e1ad1b3e0e5f85868f076dc928ca152e83b0 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/tamil) |
| `NotoSansTelugu-Regular.ttf` | `NotoSansTelugu-OFL.txt` | d400fc52bedbdd63cb251764814e5ec3232bfbd723ee972eea805119e6228bbc | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/telugu) |
| `NotoSansThai-Regular.ttf` | `NotoSansThai-OFL.txt` | fd8b586a0672c6a79861edb730f38914f0711c912bd997e77defba86903a8759 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/thai) |

## JP, KR and TC regular instances

These three static fonts were generated from the official
[Noto CJK variable TTF subset sources](https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Variable/TTF/Subset)
at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c` (font version 2.004).
Their source SHA-256 hashes are:

| Source | SHA-256 |
| --- | --- |
| `NotoSansJP-VF.ttf` | f4b373b226668ee33a6e54b02823dcd2d1209f17159f777421ae8c2275160369 |
| `NotoSansKR-VF.ttf` | 9e1d729e7e2b36f9ef439da102f8c134c10aabe46f1c843bf0aca5c043b86f76 |
| `NotoSansTC-VF.ttf` | ac091cc8cd19e848202afc8fe6d3809b4526c8fdbdb4be82da20c4f785949591 |

Generate each with FontTools 4.60.1 using
`fonttools varLib.instancer NotoSansJP-VF.ttf wght=400 --static --update-name-table --no-recalc-timestamp -o NotoSansJP-Regular.ttf`,
substituting KR and TC as appropriate. The JP output was reproduced byte for
byte locally. The new cmap contains every character present in the previous
JP, KR and TC binaries, plus additional characters. The accompanying OFL files
retain the copyright notice and full license terms.
