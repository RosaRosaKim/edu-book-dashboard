# Deploy to main

develop 브랜치에서 빌드 후 결과물을 main 브랜치에 배포한다.

사용자 인자($ARGUMENTS)가 있으면 커밋 메시지에 포함한다.

## 절차

1. **브랜치 확인** — 현재 브랜치가 `develop`인지 확인. 아니면 중단.
2. **미커밋 변경 확인** — `git status`로 develop에 스테이지되지 않은 변경이 있으면 경고하고 사용자에게 계속할지 확인.
3. **빌드** — `npm run build` 실행. 실패하면 즉시 중단.
4. **임시 복사** — 빌드된 `edu-book-dashboard.html`을 `_deploy_tmp.html`로 복사.
5. **main 전환** — `git checkout main`
6. **파일 교체** — `_deploy_tmp.html`을 `edu-book-dashboard.html`로 이동(덮어쓰기).
7. **커밋** — 변경사항을 스테이지하고 커밋:
   - 인자가 있으면: `Deploy: $ARGUMENTS`
   - 없으면: `Deploy: built dashboard`
8. **복귀** — `git checkout develop`
9. **결과 출력** — 커밋 해시와 성공 메시지 표시.

## 주의사항

- 절대 원격에 push하지 않는다 (사용자가 명시적으로 요청하지 않는 한).
- 빌드 실패 시 즉시 중단하고 develop에 머문다.
- main 전환 후 문제가 생기면 develop으로 복귀한 뒤 에러를 보고한다.
- `_deploy_tmp.html` 임시 파일은 반드시 정리한다.
