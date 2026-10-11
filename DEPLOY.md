# ☁️ PaperDex 배포 가이드 (개인 계정 · 무료)

**Supabase**(로그인 + DB + 이미지 저장)와 **Vercel**(웹사이트 호스팅)을 써요. 둘 다 무료 플랜으로 충분해요.
다 하는 데 15~20분 정도 걸려요.

> ⚠️ 이 단계들은 **개인 컴퓨터에서 개인 계정으로** 진행해주세요. 회사 연구와 관련된 내용은 올리지 않는 걸 추천해요.

---

## 0. 준비: 개인 컴퓨터로 옮기기

1. 로컬 PaperDex 하단에서 **💾 내보내기 (JSON)** 를 눌러요. 스크린샷까지 포함된 백업 파일이 받아져요.
2. `paperdex` 폴더를 개인 컴퓨터로 옮겨요. `data/` 폴더는 빼도 돼요. 데이터는 위 JSON 파일로 옮길 거예요.

## 1. Supabase 설정

1. https://supabase.com 에 가입하고 **New project** 를 만들어요. Region 은 `Northeast Asia (Seoul)` 을 추천해요. DB 비밀번호는 아무거나 정해도 돼요.
2. 왼쪽 메뉴 **SQL Editor** 에서 이 폴더의 `supabase.sql` 내용을 전부 붙여넣고 **Run** 을 눌러요. 데이터 테이블과 비공개 이미지 저장소가 만들어져요.
3. **Authentication → Users → Add user → Create new user** 에서 내 이메일과 비밀번호를 넣어요. 이때 **Auto Confirm User** 를 체크해요.
4. **Authentication → Sign In / Providers** 에서 **Allow new users to sign up** 을 **꺼요**. 다른 사람이 가입하지 못하게 막는 설정이에요.
5. **Project Settings → API** 에서 두 값을 복사해요.
   - `Project URL`
   - `anon` `public` key
6. `static/config.js` 를 열어서 복사한 값을 넣어요.

   ```js
   window.PAPERDEX_CONFIG = {
     supabaseUrl: 'https://xxxx.supabase.co',
     supabaseAnonKey: 'eyJhbGciOi...',
   };
   ```

   anon key 는 브라우저에 공개되도록 설계된 키라 깃에 올라가도 괜찮아요. 데이터는 로그인과 RLS 정책으로 내 계정만 접근할 수 있어요.

## 2. GitHub 에 올리기

1. GitHub 에서 **Private** 저장소를 새로 만들어요. 예: `paperdex`
2. 폴더에서 아래 명령을 실행해요. `.gitignore` 가 `data/` 를 빼주니까 개인 데이터는 올라가지 않아요.

   ```bash
   cd paperdex
   git init && git add . && git commit -m "PaperDex"
   git branch -M main
   git remote add origin https://github.com/<내아이디>/paperdex.git
   git push -u origin main
   ```

## 3. Vercel 배포

1. https://vercel.com 에 GitHub 계정으로 가입해요.
2. **Add New → Project** 에서 `paperdex` 저장소를 **Import** 해요.
3. Framework Preset 은 **Other** 로 두고, 나머지는 건드리지 말고 **Deploy** 를 눌러요. `vercel.json` 이 `static/` 폴더와 `api/arxiv.js` 함수를 알아서 잡아줘요.
4. 1분쯤 지나면 `https://paperdex-xxxx.vercel.app` 같은 주소가 나와요. 🎉

이후로는 `git push` 할 때마다 자동으로 다시 배포돼요.

## 4. 데이터 옮기기

1. 배포된 주소로 들어가서 1-3 에서 만든 계정으로 로그인해요.
2. 하단 **📥 가져오기** 에서 0단계에서 받은 JSON 을 선택해요. 논문, 아이디어, 스크린샷이 전부 클라우드로 올라가요.

## 5. 폰에서 앱처럼 쓰기

- **iPhone**: Safari 로 사이트를 열고 공유 버튼 → **홈 화면에 추가**
- **Android**: Chrome 메뉴 → **홈 화면에 추가**

---

### 참고

- **로컬 모드 / 클라우드 모드**: `config.js` 가 비어 있으면 `python3 server.py` 로 로컬에서 돌아가고, 값이 채워져 있으면 어디서 열든 Supabase 를 써요.
- **Supabase 무료 플랜**은 **7일 동안 아무 접속이 없으면 프로젝트가 일시정지**돼요. 대시보드에서 Restore 를 누르면 다시 켜져요. 매일 쓰면 걱정 안 해도 돼요.
- **백업**: 가끔 **💾 내보내기** 로 JSON 을 받아두면 안전해요. 이미지도 포함돼요.
- **용량**: 무료 플랜은 DB 500MB, 파일 저장소 1GB 예요. 스크린샷은 자동으로 압축되니까 수천 장까지 괜찮아요.
