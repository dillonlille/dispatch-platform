"""Disposable native DSP lab; never installs Dispatch on the runner host."""
import argparse, hashlib, http.server, json, os, pathlib, shutil, socket, subprocess, tarfile, tempfile, threading, time, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[4]
IMAGE = 'https://cloud-images.ubuntu.com/releases/noble/release/'
NAME = 'ubuntu-24.04-server-cloudimg-amd64.img'
def run(args, **kw):
    return subprocess.run([str(x) for x in args], check=True, **kw)
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def main():
    p = argparse.ArgumentParser(); p.add_argument('--report', default='/tmp/dispatch-native-dsp-lab-report.json'); p.add_argument('--package'); p.add_argument('--keep-on-failure', action='store_true'); args = p.parse_args()
    report = pathlib.Path(args.report).resolve(); report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({'status':'running','cases':[]}))
    try:
        if shutil.disk_usage('/var/tmp').free < 15 * 1024**3: raise RuntimeError('15 GiB free space required')
        if not os.access('/dev/kvm', os.R_OK | os.W_OK): run(['sudo','-n','test','-r','/dev/kvm'])
        run(['sudo','-n','true'])
        for tool in ['qemu-system-x86_64','qemu-img','ssh','scp','node','patchelf']:
            if not shutil.which(tool): raise RuntimeError('Missing lab prerequisite: '+tool)
        if not (ROOT/'dashboard/node_modules/@playwright/test').exists(): raise RuntimeError('Install dashboard dependencies before running the lab')
    except Exception as error:
        report.write_text(json.dumps({'status':'failed','cases':[],'error':str(error)},indent=2))
        raise
    work = pathlib.Path(tempfile.mkdtemp(prefix='dispatch-dsp-lab-', dir='/var/tmp')); os.chmod(work, 0o700)
    vm = None; server = None; tunnel = None; success = False; ssh = None; scp = None
    def cleanup():
        if vm and vm.poll() is None and ssh:
            try:
                subprocess.run([str(x) for x in ssh]+['sync && systemctl poweroff'],timeout=15,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                vm.wait(timeout=30)
            except (subprocess.TimeoutExpired, OSError): pass
        if vm and vm.poll() is None:
            subprocess.run(['sudo','-n','kill','-TERM',str(vm.pid)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try: vm.wait(timeout=20)
            except subprocess.TimeoutExpired: subprocess.run(['sudo','-n','kill','-KILL',str(vm.pid)], check=False); vm.wait(timeout=10)
        if tunnel and tunnel.poll() is None:
            tunnel.terminate(); tunnel.wait(timeout=10)
        if server: server.shutdown()
        if not success and args.keep_on_failure:
            print('Disposable lab retained for debugging:', work, flush=True)
        else:
            # Root-owned guest/image files are contained below this generated directory.
            run(['sudo','-n','python3','-c','import shutil,sys; shutil.rmtree(sys.argv[1])',work])
    try:
        print('Downloading and verifying disposable Ubuntu image', flush=True)
        urllib.request.urlretrieve(IMAGE+NAME, work/'disk.qcow2')
        sums=urllib.request.urlopen(IMAGE+'SHA256SUMS', timeout=30).read().decode()
        expected=next(line.split()[0] for line in sums.splitlines() if line.split()[-1].lstrip('*') == NAME)
        with open(work/'disk.qcow2','rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
        if actual != expected: raise RuntimeError('Ubuntu image checksum mismatch')
        run(['qemu-img','resize',work/'disk.qcow2','24G'], stdout=subprocess.DEVNULL)
        run(['ssh-keygen','-q','-t','ed25519','-N','','-f',work/'key'])
        seed=work/'seed';seed.mkdir(); (seed/'meta-data').write_text('instance-id: dispatch-dsp-lab\nlocal-hostname: dispatch-dsp-lab\n')
        (seed/'user-data').write_text('#cloud-config\ndisable_root: false\nssh_pwauth: false\nusers:\n  - name: root\n    ssh_authorized_keys:\n      - '+(work/'key.pub').read_text().strip()+'\n')
        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self,*a,**kw): super().__init__(*a,directory=str(seed),**kw)
            def log_message(self,*a): pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler); threading.Thread(target=server.serve_forever,daemon=True).start()
        ssh_port=port(); app_port=port()
        command=['sudo','-n','qemu-system-x86_64','-enable-kvm','-cpu','host','-m','4096','-smp','2','-nographic','-drive',f'file={work}/disk.qcow2,format=qcow2,if=virtio','-netdev',f'user,id=net0,hostfwd=tcp:127.0.0.1:{ssh_port}-:22','-device','virtio-net-pci,netdev=net0','-smbios',f'type=1,serial=ds=nocloud-net;s=http://10.0.2.2:{server.server_port}/']
        with open(work/'console.log','wb') as console: vm=subprocess.Popen(command,stdout=console,stderr=subprocess.STDOUT)
        ssh=['ssh','-i',work/'key','-p',str(ssh_port),'-o',f'UserKnownHostsFile={work}/known_hosts','-o','StrictHostKeyChecking=accept-new','-o','ConnectTimeout=3','root@127.0.0.1']
        (work/'connection.json').write_text(json.dumps({'sshPort':ssh_port,'appPort':app_port}))
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            if subprocess.run([str(x) for x in ssh]+['true'], stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
            if vm.poll() is not None: raise RuntimeError('VM exited before SSH became available')
            time.sleep(2)
        else: raise RuntimeError('VM SSH readiness timeout')
        # Export tracked working files, including in-progress lab changes, without secrets/caches/git history.
        files=subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
        with tarfile.open(work/'source.tar','w') as tar:
            for name in sorted(set(filter(None,files))):
                file=ROOT/name
                if file.is_file(): tar.add(file,arcname=name,recursive=False)
        package=pathlib.Path(args.package).resolve() if args.package else work/'package'
        if not args.package: run([ROOT/'runtime/tooling/build',package],cwd=ROOT)
        # Bootstrap with the exact host Node and its private dependencies, not the distro's old Node.
        run(['node','-e',"require('./dispatch-core/provisioner/src/portable-node').bundleNode(process.execPath,process.argv[1])",work/'node'],cwd=ROOT)
        with tarfile.open(work/'node.tar','w') as tar: tar.add(work/'node',arcname='dispatch-node')
        scp=['scp','-i',work/'key','-P',str(ssh_port),'-o',f'UserKnownHostsFile={work}/known_hosts']
        run(scp+[work/'source.tar',work/'node.tar',package/'runtime.tar.gz',package/'descriptor.json','root@127.0.0.1:/root/'])
        print('Installing and starting the isolated acceptance lab',flush=True)
        run(ssh+['mkdir /work && tar xf /root/source.tar -C /work && chown -R root:root /work && mkdir -p /usr/local/lib && tar xf /root/node.tar --no-same-owner -C /usr/local/lib && cp -R /usr/local/lib/dispatch-node/host-files/usr/share/nodejs /usr/share/ && ln -sf /usr/local/lib/dispatch-node/node /usr/bin/node && node --no-warnings /work/core/installations/tests/native-lab/setup.js'],stdout=open(work/'setup.log','w'),stderr=subprocess.STDOUT,timeout=900)
        print('Exercising dashboard, provisioner and DSP lifecycle',flush=True)
        run(ssh+['node --no-warnings /work/core/installations/tests/native-lab/scenarios.js'],stdout=open(work/'scenarios.log','w'),stderr=subprocess.STDOUT,timeout=3600)
        print('Rebooting the restored VM and verifying the real browser workflow',flush=True)
        run(ssh+['sync && systemctl reboot'])
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            probe=subprocess.run([str(x) for x in ssh]+['test "$(cat /proc/sys/kernel/random/boot_id)" != "$(cat /root/lab-boot-id)" && curl --fail --silent http://127.0.0.1:4310/api/platform/core-health >/dev/null'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if probe.returncode==0: break
            time.sleep(2)
        else: raise RuntimeError('Restored VM reboot readiness timeout')
        tunnel=subprocess.Popen([str(x) for x in ssh[:-1]]+['-N','-L',f'127.0.0.1:{app_port}:127.0.0.1:4310','-o','ExitOnForwardFailure=yes',ssh[-1]],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{app_port}/',timeout=2).close(); break
            except OSError: time.sleep(.5)
        else: raise RuntimeError('Browser SSH tunnel failed')
        run(['node','--no-warnings',ROOT/'core/installations/tests/native-lab/browser.js',f'http://127.0.0.1:{app_port}',str(report)+'.browser.json'],cwd=ROOT,timeout=180)
        run(ssh+['node --no-warnings /work/core/installations/tests/native-lab/after-reboot.js'],stdout=open(work/'after-reboot.log','w'),stderr=subprocess.STDOUT,timeout=1800)
        run(scp+['root@127.0.0.1:/root/lab-report.json',report])
        results=json.loads(report.read_text()); results['cases']+=json.loads(pathlib.Path(str(report)+'.browser.json').read_text())['cases']; report.write_text(json.dumps(results,indent=2))
        success=json.loads(report.read_text())['status']=='passed'
        if not success: raise RuntimeError('Acceptance report contains failures')
        print('Native DSP acceptance passed:',report,flush=True)
    except Exception as error:
        if ssh and scp:
            try:
                subprocess.run([str(x) for x in scp]+['root@127.0.0.1:/root/lab-report.json',str(report)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            except (subprocess.TimeoutExpired, OSError): pass
            with open(str(report)+'.journal.log','w') as out:
                try:
                    subprocess.run([str(x) for x in ssh]+['journalctl --no-pager -n 150'],stdout=out,stderr=subprocess.STDOUT,timeout=30)
                except (subprocess.TimeoutExpired, OSError): pass
        result=json.loads(report.read_text()); result['status']='failed'; result['error']=str(error); report.write_text(json.dumps(result,indent=2))
        for name in ['setup.log','scenarios.log','after-reboot.log']:
            if (work/name).exists(): shutil.copyfile(work/name,str(report)+'.'+name)
        raise
    finally: cleanup()
if __name__=='__main__': main()
