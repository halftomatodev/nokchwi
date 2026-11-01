"""녹음 폴더를 계속 지켜보다가 새 녹음마다 단어별 시간이 든 json 전사를 만든다. 이미 json이 있으면 건너뛴다."""
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REC_DIR = ROOT / '녹음'
MODEL = 'large-v3'
AUDIO = {'.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus', '.webm', '.mp4', '.mov', '.caf'}
SCAN_SECONDS = 3
SETTLE_SECONDS = 5   # 동기화 중인 파일을 건드리지 않도록, 크기가 이만큼 그대로일 때만 시작한다
IDLE_RELEASE_SECONDS = 300   # 할 일이 없으면 그래픽 메모리를 비운다
MAX_TRIES = 3


def add_cuda_dlls():
    # pip로 받은 cuBLAS / cuDNN DLL을 찾을 수 있게 경로에 추가한다 (Windows)
    for pkg in ('nvidia.cublas', 'nvidia.cudnn'):
        try:
            spec = importlib.util.find_spec(pkg)
        except ModuleNotFoundError:
            continue
        if not spec or not spec.submodule_search_locations:
            continue
        for p in spec.submodule_search_locations:
            b = os.path.join(p, 'bin')
            if os.path.isdir(b):
                os.add_dll_directory(b)
                os.environ['PATH'] = b + os.pathsep + os.environ['PATH']


def load(device):
    from faster_whisper import WhisperModel
    if device == 'cuda':
        return WhisperModel(MODEL, device='cuda', compute_type='float16')
    return WhisperModel(MODEL, device='cpu', compute_type='int8')


class Engine:
    def __init__(self):
        self.model = None
        self.device = 'cuda'

    def ready(self):
        if self.model:
            return
        print('모델을 불러오는 중…')
        add_cuda_dlls()
        try:
            self.model = load(self.device)
        except Exception as e:
            print(f'GPU를 쓸 수 없어 CPU로 진행합니다 (느림): {e}')
            self.device = 'cpu'
            self.model = load(self.device)

    def release(self):
        if self.model:
            self.model = None
            print('쉬는 동안 모델을 내려 두었습니다. 새 녹음이 들어오면 다시 불러옵니다.')

    def fall_back_to_cpu(self):
        self.device = 'cpu'
        self.model = load(self.device)


def transcribe(model, path):
    def run(vad):
        segs, info = model.transcribe(str(path), beam_size=5, vad_filter=vad, word_timestamps=True,
                                      condition_on_previous_text=False)
        out = []
        for s in segs:
            words = [{'w': w.word, 's': round(w.start, 3), 'e': round(w.end, 3)} for w in (s.words or [])]
            if words:
                out.append({'s': round(s.start, 3), 'e': round(s.end, 3), 'words': words})
                print(f'    {s.end / max(info.duration, 0.01):4.0%}  {s.text.strip()}')
        return out, info
    # 배경음 때문에 VAD가 목소리까지 잘라 버리면 VAD 없이 다시 시도
    segments, info = run(True)
    if not segments:
        segments, info = run(False)
    return {'version': 1, 'language': info.language, 'duration': round(info.duration, 3),
            'source': path.name, 'segments': segments}


def write_result(path, result):
    target = path.with_suffix('.json')
    temp = target.with_suffix('.json.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, target)


def process(engine, path):
    engine.ready()
    try:
        result = transcribe(engine.model, path)
    except Exception as e:
        if engine.device != 'cuda' or not any(k in str(e).lower() for k in ('cuda', 'cublas', 'cudnn', '.dll')):
            raise
        print(f'GPU 오류로 CPU로 전환합니다: {e}')
        engine.fall_back_to_cpu()
        result = transcribe(engine.model, path)
    write_result(path, result)


def waiting_files(seen):
    """전사할 준비가 된 파일을 돌려준다. seen에는 파일별 (크기, 처음 그 크기를 본 시각)을 기억한다."""
    ready = []
    now = time.time()
    for p in sorted(REC_DIR.iterdir()):
        if not p.is_file() or p.suffix.lower() not in AUDIO or p.with_suffix('.json').exists():
            continue
        size = p.stat().st_size
        if seen.get(p, (None,))[0] != size:
            seen[p] = (size, now)
        elif size > 0 and now - seen[p][1] >= SETTLE_SECONDS:
            ready.append(p)
    return ready


def main():
    REC_DIR.mkdir(exist_ok=True)
    print(f'녹음 폴더를 지켜보는 중입니다: {REC_DIR}')
    print('이 창을 열어 두면 새 녹음을 자동으로 전사합니다. 끝내려면 창을 닫으세요.\n')
    engine = Engine()
    seen = {}
    tries = {}
    last_work = time.time()
    while True:
        todo = [p for p in waiting_files(seen) if tries.get(p, 0) < MAX_TRIES]
        for p in todo:
            print(f'전사 시작: {p.name}')
            try:
                process(engine, p)
                print(f'완료: {p.name}\n')
            except Exception as e:
                tries[p] = tries.get(p, 0) + 1
                print(f'실패 ({tries[p]}/{MAX_TRIES}): {p.name} ({e})\n')
            last_work = time.time()
        if time.time() - last_work > IDLE_RELEASE_SECONDS:
            engine.release()
        time.sleep(SCAN_SECONDS)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('\n중단했습니다. 다시 실행하면 남은 파일부터 이어서 합니다.')
