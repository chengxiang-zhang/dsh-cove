import { execFileSync } from 'node:child_process'

// openat-style traversal anchors every child to an already-open directory. A
// path check followed by fs.copyFile can be raced through a replaced ancestor.
const SNAPSHOT = String.raw`
import os, sys, json, stat, hashlib
c=json.load(sys.stdin)
flags=os.O_RDONLY|os.O_NOFOLLOW
root=os.open(c['source'],flags|os.O_DIRECTORY)
total=0
def scan(fd,prefix='',copy=False):
    global total
    result=[]
    for name in sorted(os.listdir(fd)):
        info=os.stat(name,dir_fd=fd,follow_symlinks=False)
        path=prefix+name
        if stat.S_ISDIR(info.st_mode):
            child=os.open(name,flags|os.O_DIRECTORY,dir_fd=fd)
            try:
                if copy: os.mkdir(os.path.join(c['destination'],path),0o700)
                result.extend(scan(child,path+'/',copy))
            finally: os.close(child)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:
            child=os.open(name,flags,dir_fd=fd)
            try:
                current=os.fstat(child)
                if not stat.S_ISREG(current.st_mode) or current.st_nlink!=1: raise RuntimeError('CANDIDATE_UNSAFE_FILE')
                if current.st_size>33554432: raise RuntimeError('CANDIDATE_TOO_LARGE')
                with os.fdopen(os.dup(child),'rb') as f: data=f.read(33554433)
                total+=len(data)
                if len(data)>33554432 or total>67108864: raise RuntimeError('CANDIDATE_TOO_LARGE')
                if copy:
                    out=os.open(os.path.join(c['destination'],path),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400)
                    with os.fdopen(out,'wb') as f: f.write(data)
                result.append({'path':path,'digest':hashlib.sha256(data).hexdigest()})
            finally: os.close(child)
        else: raise RuntimeError('CANDIDATE_UNSAFE_FILE')
        if len(result)>10000: raise RuntimeError('CANDIDATE_TOO_LARGE')
    return result
try:
    copied=scan(root,copy=True)
    if copied!=scan(root): raise RuntimeError('CANDIDATE_CHANGED_DURING_SEAL')
    print(json.dumps(copied,separators=(',',':')))
finally: os.close(root)
`

/** Fixed trusted preparation process; candidate code and hooks are never loaded. */
export function snapshotVerificationSource(
  source: string,
  destination: string
): { path: string; digest: string }[] {
  try {
    const output = execFileSync('/usr/bin/python3', ['-I', '-c', SNAPSHOT], {
      input: JSON.stringify({ source, destination }),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 2 * 1048576,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return JSON.parse(output)
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    if (stderr.includes('CANDIDATE_TOO_LARGE')) throw new Error('CANDIDATE_TOO_LARGE')
    if (stderr.includes('CANDIDATE_CHANGED_DURING_SEAL'))
      throw new Error('CANDIDATE_CHANGED_DURING_SEAL')
    throw new Error('CANDIDATE_UNSAFE_FILE', { cause: error })
  }
}
