# 균열의 계약자 (마법소녀/소년 텍스트 RPG)

기획서: [마법소녀 소년 텍스트 RPG 기획서.md](./마법소녀%20소년%20텍스트%20RPG%20기획서.md)

## 지금 되는 것 (로드맵 1~2단계)

- 회원가입 / 로그인 (닉네임 + 비밀번호, 비밀번호는 해시로 저장)
- 캐릭터 선택 · 생성 · 삭제 (계정당 최대 5개)
  - 이름, 성별, 속성 8종, 클래스 3종, 계약 신 5명
  - 고르는 대로 스탯과 HP/MP/회피율/치명타율 미리보기
- 필드: 본부 4구역 + 공원 균열 6구역을 버튼으로 이동, 둘러보기
- 같은 구역에 있는 사람 목록, 지역 채팅, 전체 채팅 (도배 방지 포함)
- 끊겨도 30초 동안 캐릭터 유지 → 새로고침/재접속하면 그 자리로 복귀
- 캐릭터 정보 창, 지도 창 (파괴도는 아직 0% 고정)

아직 없는 것: 전투, 토벌 이벤트 (3단계), 아이템·상점·거래 (4단계), OC 프로필 편집.

## 1. 내 컴퓨터에서 테스트하기

필요한 것: [Node.js](https://nodejs.org) 20 이상 (LTS 버전 설치 추천)

```bash
git clone https://github.com/yr522/magical-rpg.git
cd magical-rpg
git checkout claude/stoic-rubin-sdyiic   # 아직 main에 합치기 전이라면
npm install
npm start
```

`http://localhost:3000 에서 실행 중`이 뜨면 브라우저에서 <http://localhost:3000> 을 연다.
DB 설정이 없어도 `data/local-db.json` 파일에 저장되면서 돌아간다.

**혼자서 두 명 흉내 내기**: 일반 창 하나 + 시크릿 창 하나를 열고 각각 다른 닉네임으로 가입하면,
서로 같은 구역에 보이고 채팅이 오가는지 확인할 수 있다.

**같은 와이파이의 폰으로 접속**: 컴퓨터의 내부 IP(예: `192.168.0.12`)를 확인한 뒤
폰 브라우저에서 `http://192.168.0.12:3000` 으로 접속한다. (방화벽이 막으면 허용)

### 확인해 볼 체크리스트

1. 회원가입 → 로그아웃 → 같은 닉네임/비밀번호로 로그인
2. 캐릭터 만들기: 클래스·계약 신을 바꾸면 스탯 미리보기가 바뀌는지
3. 캐릭터 시작 → 본부 광장에 도착
4. 다른 창의 캐릭터가 "이곳의 계약자" 목록에 보이는지, 지역 채팅이 서로 보이는지
5. 한 명이 `남쪽 성문 · 공원 균열`로 이동 → 다른 쪽 목록에서 사라지고, 지역 채팅은 안 보이고, **전체** 채팅은 보이는지
6. 게임 중에 새로고침 → 같은 캐릭터, 같은 장소로 돌아오는지
7. 창을 닫으면 상대 화면에 "(자리 비움)" → 30초 뒤 "떠났다"
8. 서버를 껐다 켜도 캐릭터와 마지막 위치가 남아 있는지

자동 테스트도 있다: `npm test`

## 2. 인터넷에 올려서 지인과 테스트하기 (무료)

### ① Supabase (DB)

1. <https://supabase.com> 가입 → **New project** (비밀번호는 따로 적어 두기, 지역은 Northeast Asia (Seoul) 추천)
2. 프로젝트 화면 위쪽의 **Connect** 버튼 → **Session pooler** 탭의 연결 주소를 복사
   - `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-...pooler.supabase.com:5432/postgres` 모양
   - `[YOUR-PASSWORD]` 자리에 1번에서 정한 비밀번호를 넣는다
   - **Direct connection 주소는 쓰지 말 것** (Render 무료에서 접속이 안 될 수 있음)
3. 테이블은 만들 필요 없다. 서버가 처음 켜질 때 자동으로 만든다.

### ② Render (게임 서버)

1. <https://render.com> 에 GitHub 계정으로 가입
2. **New → Blueprint** → `yr522/magical-rpg` 저장소 선택 → 브랜치 선택
   (이 저장소의 `render.yaml`을 읽어 설정이 자동으로 채워진다)
3. `DATABASE_URL` 칸에 ①에서 복사한 주소를 붙여 넣고 **Apply**
4. 배포가 끝나면 `https://magical-rpg-xxxx.onrender.com` 같은 주소가 생긴다. 이 주소를 지인들에게 공유

서버 로그에 `저장소: Postgres (DATABASE_URL)`가 보이면 Supabase에 잘 연결된 것이다.
Supabase 대시보드의 **Table Editor**에서 `users`, `characters` 테이블에 가입한 계정이 쌓이는 것도 볼 수 있다.

### ③ 잠들기 방지 (선택이지만 추천)

Render 무료 서버는 15분 동안 아무도 없으면 잠들고, 깨어나는 데 1분쯤 걸린다.
<https://uptimerobot.com> 에서 무료 HTTP 모니터를 만들고 주소를 `https://(내 주소)/health`, 간격 5~10분으로 정하면 계속 깨어 있다.

## 폴더 구조

| 경로 | 내용 |
| --- | --- |
| `server/index.js` | 서버 진입점. 접속·로그인·캐릭터·이동·채팅 처리 |
| `server/game.js` | 캐릭터 생성 규칙, 스탯 공식, 맵 검사 |
| `server/db.js`, `server/schema.sql` | 저장소 (Supabase Postgres 또는 로컬 파일) |
| `server/auth.js` | 비밀번호 해시, 로그인 토큰 |
| `server/data/character.json` | 성별·속성·클래스·계약 신·시작 스탯 (**수치 조정은 여기서**) |
| `server/data/map.json` | 지역과 구역, 묘사 문장, 출구 (**맵 추가는 여기서**) |
| `public/` | 브라우저 화면 (HTML/CSS/JS) |
| `test/` | 자동 테스트 |

`map.json`에 구역을 추가할 때는 양쪽 구역 모두에 출구를 적어야 한다.
한쪽만 적으면 서버가 켜질 때 어떤 구역이 문제인지 알려 주고 멈춘다.
