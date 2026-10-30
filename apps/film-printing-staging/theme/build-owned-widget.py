"""Build BFL's isolated, pinned UI fork; input is the official npm full bundle.

No runtime prototype patch, provider credential or package install script.
Keep upstream's BSD-2-Clause license alongside the generated artifact.
"""
import hashlib,pathlib,sys
source=pathlib.Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(source).hexdigest()=='64f483023587dfaf0576accf4f3c0cfdcd4e7c70cba1c8c46914a59c66ba5076'
text=source.decode()
changes=[
 ('newFile = _this5.widget.applySelectionToFile(_this5.file);',
  'newFile = _this5.widget.applySelectionToFile(_this5.file); if (_this5.settings.bflOwnedCrop) newFile = _this5.settings.bflOwnedCrop(_this5.file, newFile);'),
 ('global.uploadcare = factory()', 'global.BFLOwnedWidget = factory()'),
 ('results.push(new converters[type](param, s, info).promise());',
  'if (typeof s.bflOwnedFileFactory !== "function") throw new Error("BFL_OWNED_TRANSPORT_REQUIRED"); results.push(s.bflOwnedFileFactory(type, param, s, info));'),
 ('value: function __createGroup() {\n        var _this4 = this;',
  'value: function __createGroup() {\n        if (this.settings.bflOwnedFileFactory) return jquery.Deferred().resolve({id: null}).promise();\n        var _this4 = this;'),
 ('file = new UrlFile(url, _this2.settings, sourceInfo);\n          if (message.filename) {\n            file.setName(message.filename);\n          }\n          if (message.is_image != null) {\n            file.setIsImage(message.is_image);\n          }\n          return _this2.dialogApi.addFiles([file.promise()]);',
  'return _this2.dialogApi.addFiles(filesFrom("url", [[url, sourceInfo]], _this2.settings));'),
 ('var loadFileGroup = function loadFileGroup(groupIdOrUrl, settings) {',
  'var loadFileGroup = function loadFileGroup(groupIdOrUrl, settings) {\n    if (settings && settings.bflOwnedFileFactory) return jquery.Deferred().reject().promise();')]
for before,after in changes:
 assert text.count(before)==1, 'Upstream patch boundary changed'
 text=text.replace(before,after,1)
target=pathlib.Path(sys.argv[2]);target.write_text(text)
print(hashlib.sha256(target.read_bytes()).hexdigest())
