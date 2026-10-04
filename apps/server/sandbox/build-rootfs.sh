#!/bin/sh
set -eu

# Run in the clean toolchain build stage, never against the API image. Only
# public runtime/toolchain files are copied; no app, proc, sys, home or secrets.
destination=${1:?rootfs destination required}
mkdir -p "$destination/usr" "$destination/etc" "$destination/dev" \
  "$destination/workspace" "$destination/tmp"
cp -a /usr/. "$destination/usr/"
ln -s usr/bin "$destination/bin"
ln -s usr/sbin "$destination/sbin"
ln -s usr/lib "$destination/lib"
if [ -e /usr/lib64 ]; then ln -s usr/lib64 "$destination/lib64"; fi
cp -a /etc/alternatives /etc/ssl "$destination/etc/"
for configuration in /etc/java-* /etc/python*; do
  if [ -d "$configuration" ]; then cp -a "$configuration" "$destination/etc/"; fi
done
cp -a /etc/ld.so.conf /etc/ld.so.conf.d "$destination/etc/"
# glibc normally resolves Java's $ORIGIN library paths through /proc/self/exe.
# The jail deliberately has no proc mount, so include the JDK's public native
# library directories in its own loader cache instead.
find "$destination/usr/lib/jvm" \( -name libjli.so -o -name libjvm.so \) -printf '%h\n' | while IFS= read -r library; do
  printf '%s\n' "${library#"$destination"}" >> "$destination/etc/ld.so.conf"
done
ldconfig -r "$destination"
printf 'root:x:0:0:root:/:/bin/bash\n' > "$destination/etc/passwd"
printf 'root:x:0:\n' > "$destination/etc/group"
printf 'passwd: files\ngroup: files\nhosts: files\n' > "$destination/etc/nsswitch.conf"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$destination/etc/hosts"
for device in null zero random urandom tty; do
  cp -a "/dev/$device" "$destination/dev/$device"
done

# setuid/setgid files are unnecessary and cannot grant privilege after the
# launcher's no_new_privs. Strip their bits as an additional invariant.
find "$destination/usr" -perm /6000 -exec chmod a-s {} +
chmod -R a-w "$destination/usr" "$destination/etc"
chmod 755 "$destination" "$destination/dev" "$destination/workspace" "$destination/tmp"
