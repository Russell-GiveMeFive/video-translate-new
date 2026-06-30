"""
DramaPrime demucs CLI wrapper for PyInstaller.

Acts as a drop-in replacement for the `demucs` shell command:
    ./demucs --two-stems vocals -n htdemucs_ft -o <out> <input>

PyInstaller 包成 onedir 后，binary 入口 `demucs` 就是这个文件的编译结果。
"""
import sys

# 强制走 CPU；防止运行机器误开 MPS/CUDA 导致首次加载缓慢
import os
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
os.environ.setdefault('CUDA_VISIBLE_DEVICES', '')

# 让 torchhub 找到打包进 binary 的预下载模型
# PyInstaller sys._MEIPASS 是 onedir 时的临时解压根（onedir 模式下就是 binary 所在目录）
if hasattr(sys, '_MEIPASS'):
    # 预先把权重放在 _internal/torch_hub/checkpoints/ 下
    os.environ['TORCH_HOME'] = os.path.join(sys._MEIPASS, 'torch_hub')

from demucs.separate import main

if __name__ == '__main__':
    main()
