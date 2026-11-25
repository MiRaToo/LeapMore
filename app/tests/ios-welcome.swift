import Foundation
import Vision

let screenshot = URL(fileURLWithPath: CommandLine.arguments[1])
let text = VNRecognizeTextRequest()
text.recognitionLevel = .accurate
text.recognitionLanguages = ["zh-Hans", "en-US"]
try VNImageRequestHandler(url: screenshot, options: [:]).perform([text])
let words = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }
let joined = words.joined().filter { !$0.isWhitespace }
print(words.joined(separator: " | "))
exit(joined.localizedCaseInsensitiveContains("LeapMore") && joined.contains("我知道了") ? 0 : 1)
