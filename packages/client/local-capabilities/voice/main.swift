// magic-voice —— 录音与本地转写（U135）
//
// 一条进程只做一件事：开着麦克风收一句中文，端侧转成文字，按行吐 JSON 事件。
// 外壳那头（`packages/client/local-capabilities/src/voice.ts`）只读 stdout 的行。
//
// 事件（一行一个 JSON 对象）：
//   {"type":"started"}                       采音已起
//   {"type":"silence"}                       静音判到，正在收尾
//   {"type":"final","text":"..."}             最终文字（唯一带正文的一条）
//   {"type":"error","code":"...","message"?}  失败
//
// 用法：
//   magic-voice                     从麦克风录一句
//   magic-voice --file <path>       转写一个音频文件（自测用，不开麦克风）
//   magic-voice --silence 1200      静音判停的毫秒数
//   magic-voice --max 60            最长录音秒数
//
// 端侧优先：`requiresOnDeviceRecognition = true`，不走网络。
// 授权：麦克风与语音识别两项都归**跑这条命令的终端 App**（系统弹窗里显示的是它），
// 本程序不自己记权限，也不提供开关。

import Foundation
import AVFoundation
import Speech
import CoreGraphics

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// 等一个**会由主队列/回调**兑现的条件——不能用信号量硬等：
/// 授权回调与识别结果都要靠 RunLoop 派发，主线程一停就永远等不到。
func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
  return condition()
}

func fail(_ code: String, _ message: String? = nil) -> Never {
  var object: [String: Any] = ["type": "error", "code": code]
  if let message { object["message"] = message }
  emit(object)
  exit(1)
}

// —— 参数 ——
var filePath: String?
var listenMode = false
var silenceMs = 1200
var maxSeconds = 60.0
var argumentIndex = 1
let arguments = CommandLine.arguments
while argumentIndex < arguments.count {
  let argument = arguments[argumentIndex]
  switch argument {
  case "--file":
    argumentIndex += 1
    if argumentIndex < arguments.count { filePath = arguments[argumentIndex] }
  case "--silence":
    argumentIndex += 1
    if argumentIndex < arguments.count { silenceMs = Int(arguments[argumentIndex]) ?? silenceMs }
  case "--listen":
    listenMode = true
  case "--max":
    argumentIndex += 1
    if argumentIndex < arguments.count { maxSeconds = Double(arguments[argumentIndex]) ?? maxSeconds }
  default:
    break
  }
  argumentIndex += 1
}

// —— 只听按键（U135 的新取法）——
// 右 ⌥ 单独按下再松开＝一次；中途按了别的键、或同时带别的修饰键就不算。
// 实现在 `Hotkey.swift`（listen-only 的 event tap，只看不改、不吞键、不记录内容）。
if listenMode {
  // 两次上报（D75）：`down` 是按下、`up` 是松开且整次干净——外壳拿这两半配对，
  // 认「同一个窗口里按下又松开」才算一次轻点（见 `focus.ts`）。
  hotkeyHandler = { phase in emit(["type": "hotkey", "phase": phase]) }
  guard startHotkeyListener() else { fail("input-monitoring") }
  emit(["type": "listening"])
  // 外壳退订 => stdin 关掉 => 收摊。
  DispatchQueue.global().async {
    while true {
      guard let line = readLine(strippingNewline: false) else { exit(0) }
      _ = line
    }
  }
  CFRunLoopRun()
  exit(0)
}

// —— 授权 ——
func authorizedRecognizer() -> SFSpeechRecognizer {
  var status = SFSpeechRecognizer.authorizationStatus()
  if status == .notDetermined {
    var answered = false
    SFSpeechRecognizer.requestAuthorization { _ in answered = true }
    if !waitUntil(timeout: 120, { answered }) { fail("auth-timeout") }
    status = SFSpeechRecognizer.authorizationStatus()
  }
  switch status {
  case .authorized: break
  case .denied: fail("denied")
  case .restricted: fail("restricted")
  default: fail("not-authorized")
  }

  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else {
    fail("locale-unavailable")
  }
  guard recognizer.supportsOnDeviceRecognition else { fail("on-device-unavailable") }
  return recognizer
}

let recognizer = authorizedRecognizer()

// —— 转写一个文件（自测那条路，不开麦克风）——
if let path = filePath {
  let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  request.requiresOnDeviceRecognition = true
  request.addsPunctuation = true
  var settled = false
  _ = recognizer.recognitionTask(with: request) { result, error in
    if settled { return }
    if let error {
      settled = true
      emit(["type": "error", "code": "recognize", "message": String(describing: error)])
      return
    }
    if let result, result.isFinal {
      settled = true
      emit(["type": "final", "text": result.bestTranscription.formattedString])
    }
  }
  if !waitUntil(timeout: 120, { settled }) { fail("timeout") }
  exit(0)
}

// —— 从麦克风录一句 ——
let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.inputFormat(forBus: 0)
guard format.sampleRate > 0 else { fail("no-input-device") }

let request = SFSpeechAudioBufferRecognitionRequest()
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = true
// 让识别器自己断句加标点（macOS 13+）——不加的话拿回来的是一串没有停顿的长句。
request.addsPunctuation = true

let startedAt = Date()
var lastVoiceAt = Date()
var spoken = false
var finished = false
var finalSettled = false
var lastText = ""
var task: SFSpeechRecognitionTask?

func finish() {
  guard !finished else { return }
  finished = true
  input.removeTap(onBus: 0)
  engine.stop()
  emit(["type": "silence"])
  request.endAudio()
  // 收尾：等最终结果；等不到就用最后一次部分结果。**不阻塞主线程**
  // （识别回调要靠主队列派发，阻塞它就会一直等下去）。
  DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    if !finalSettled { emit(["type": "final", "text": lastText]) }
    exit(0)
  }
}

task = recognizer.recognitionTask(with: request) { result, error in
  if let result {
    lastText = result.bestTranscription.formattedString
    if result.isFinal {
      finalSettled = true
      emit(["type": "final", "text": lastText])
      exit(0)
    }
  }
  if let error, !finished {
    finished = true
    emit(["type": "error", "code": "recognize", "message": String(describing: error)])
    exit(1)
  }
}

input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
  request.append(buffer)
  guard let channel = buffer.floatChannelData?[0] else { return }
  let count = Int(buffer.frameLength)
  guard count > 0 else { return }
  var sum: Float = 0
  for frame in 0..<count { sum += channel[frame] * channel[frame] }
  let rms = sqrt(sum / Float(count))
  let now = Date()
  if rms > 0.01 {
    spoken = true
    lastVoiceAt = now
  } else if spoken, now.timeIntervalSince(lastVoiceAt) * 1000 >= Double(silenceMs) {
    DispatchQueue.main.async { finish() }
  }
  if now.timeIntervalSince(startedAt) > maxSeconds {
    DispatchQueue.main.async { finish() }
  }
}

do {
  engine.prepare()
  try engine.start()
} catch {
  fail("audio-start", String(describing: error))
}
emit(["type": "started"])

// 取消那两条：外壳发 SIGTERM（或 stdin 是管道并关掉）时直接退，不吐文字。
// ⚠️ 只在 stdin 真是管道时才盯 EOF——后台/重定向跑时 stdin 一开就是 EOF，
//    盯它会在第一刻把自己退掉（本条由实测撞出来）。
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
if isatty(STDIN_FILENO) == 0 {
  DispatchQueue.global().async {
    while true {
      guard let line = readLine(strippingNewline: false) else { exit(0) }
      if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" {
        DispatchQueue.main.async { finish() }
      }
    }
  }
}

// 主队列一直转着：识别回调、收尾计时器都靠它。
_ = task
dispatchMain()
