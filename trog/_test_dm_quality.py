"""패키지 Q — DM 텍스트 품질 게이트 단위 체크. 프레임워크 없이 assert.
`python _test_dm_quality.py`. 순수함수 _dm_text_quality_ok + 히스토리 격리(_llm_slice)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def test_normal_korean_pass():
    text = ("킹짱룡이 하늘을 향해 포효하자 대기가 진동했다. 파티는 숨을 죽이고 바위 뒤로 몸을 숨겼다. "
            "멀리서 불길이 치솟는 것을 보고 전사는 검을 고쳐 쥐었다. 이제 결전의 순간이 다가오고 있었다.")
    ok, reason = main._dm_text_quality_ok(text)
    assert ok, reason
    print("test_normal_korean_pass OK")


def test_many_latin_words_fail():
    # 라틴 4자+ 단어 6개(>5) — 붕괴 응답.
    text = ("그 유령은 accelerator engine turbine reactor booster piston 을 일으켰다고 주변을 살폈다. "
            "그것은 정말로 위협적인 존재였으며 파티는 크게 당황하여 어쩔 줄을 몰랐다. 시간이 촉박했다.")
    ok, reason = main._dm_text_quality_ok(text)
    assert not ok and reason == "latin", (ok, reason)
    print("test_many_latin_words_fail OK")


def test_exactly_five_latin_words_pass():
    # 경계값: 라틴 4자+ 단어 정확히 5개는 통과(>5 만 fail). 한글 본문이 충분히 길어 ratio 도 건강.
    text = ("전사는 sword shield armor potion scroll 다섯 물건을 조심스럽게 챙겨 넣고서 어두컴컴한 "
            "복도를 따라 한 걸음씩 천천히 나아갔다. 벽에 걸린 횃불이 바람에 흔들릴 때마다 커다란 그림자가 "
            "천장 위에서 일렁이며 춤을 추었고, 파티원들은 저마다 숨을 죽인 채 서로의 뒤를 바짝 따르며 "
            "긴장 속에서 앞으로 전진해 나갔다. 멀리서 물방울 떨어지는 소리만이 정적을 두드리고 있었다.")
    ok, reason = main._dm_text_quality_ok(text)
    assert ok, (ok, reason)
    print("test_exactly_five_latin_words_pass OK")


def test_low_hangul_ratio_fail():
    # 라틴 단어 수는 5개 이하지만 각 단어가 길어 라틴 글자 비중이 커 한글비율 < 0.75.
    text = ("정보 " + "informationtechnologysystem developmentframeworkarchitecture "
            "deploymentinfrastructurepipeline databasemanagementsolution " + "가 폭주했다 우리는 도망쳤다")
    ok, reason = main._dm_text_quality_ok(text)
    assert not ok and reason == "hangul_ratio", (ok, reason)
    print("test_low_hangul_ratio_fail OK")


def test_short_body_pass():
    # 80자 미만이면 영단어가 있어도 무조건 pass (짧은 응답 오탐 방지).
    text = "The goblin attacks now suddenly today"
    ok, reason = main._dm_text_quality_ok(text)
    assert ok, (ok, reason)
    print("test_short_body_pass OK")


def test_tags_and_dice_badges_excluded():
    # 태그·주사위 뱃지 안의 영문/숫자는 본문 평가에서 제외되어야 pass.
    # 태그를 제거하면 순수 한국어 본문만 남아 통과. (태그를 세면 latin fail 날 텍스트)
    text = ("[🎬 SCENE: dark dungeon corridor with torches] "
            "고블린이 어둠 속에서 튀어나와 전사를 덮쳤다. "
            "명중 판정 [🎲DM d20: 15] 성공! [전사 HP: 120 → 95] 날카로운 발톱이 갑옷을 긁고 지나갔다. "
            "파티는 즉시 대형을 갖추고 반격을 준비했다.")
    ok, reason = main._dm_text_quality_ok(text)
    assert ok, (ok, reason)
    print("test_tags_and_dice_badges_excluded OK")


def test_quality_bad_excluded_from_history():
    room = main.GameRoom("room_q")
    room.messages = [
        {"role": "user", "content": "전사가 문을 연다"},
        {"role": "assistant", "content": "깨진 응답 accelerator turbine", "quality_bad": True},
        {"role": "user", "content": "다시 시도한다"},
        {"role": "assistant", "content": "정상 한국어 응답이다."},
        {"role": "user", "content": "계속한다"},
    ]
    slice_ = room._llm_slice()
    contents = [m["content"] for m in slice_]
    assert "깨진 응답 accelerator turbine" not in contents, contents
    assert "정상 한국어 응답이다." in contents, contents
    # 히스토리 원본에는 그대로 남아있어야 함(화면표시 유지).
    assert any(m.get("quality_bad") for m in room.messages)
    print("test_quality_bad_excluded_from_history OK")


if __name__ == "__main__":
    test_normal_korean_pass()
    test_many_latin_words_fail()
    test_exactly_five_latin_words_pass()
    test_low_hangul_ratio_fail()
    test_short_body_pass()
    test_tags_and_dice_badges_excluded()
    test_quality_bad_excluded_from_history()
    print("\nALL DM QUALITY TESTS PASSED")
