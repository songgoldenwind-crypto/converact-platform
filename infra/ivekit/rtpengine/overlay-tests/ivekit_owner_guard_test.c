#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "../daemon/ivekit_guard.c"

static str test_str(char *value) {
	return (str) {
		.s = value,
		.len = strlen(value),
	};
}

int main(void) {
	uint64_t epoch = 0;
	char one[] = "1";
	str one_str = test_str(one);
	assert(ivekit_guard_epoch(&one_str, &epoch));
	assert(epoch == 1);

	char maximum[] = "18446744073709551615";
	str maximum_str = test_str(maximum);
	assert(ivekit_guard_epoch(&maximum_str, &epoch));
	assert(epoch == UINT64_MAX);

	char overflow[] = "18446744073709551616";
	str overflow_str = test_str(overflow);
	assert(!ivekit_guard_epoch(&overflow_str, &epoch));
	char zero[] = "0";
	str zero_str = test_str(zero);
	assert(!ivekit_guard_epoch(&zero_str, &epoch));
	char leading_zero[] = "01";
	str leading_zero_str = test_str(leading_zero);
	assert(!ivekit_guard_epoch(&leading_zero_str, &epoch));

	char command_hash[IVEKIT_GUARD_COMMAND_HASH_MAX + 1];
	memset(command_hash, 'a', IVEKIT_GUARD_COMMAND_HASH_MAX);
	command_hash[IVEKIT_GUARD_COMMAND_HASH_MAX] = '\0';
	str command_hash_str = test_str(command_hash);
	assert(ivekit_guard_hash(&command_hash_str));
	command_hash[IVEKIT_GUARD_COMMAND_HASH_MAX - 1] = 'A';
	assert(!ivekit_guard_hash(&command_hash_str));

	char identifier[513];
	memset(identifier, 'x', sizeof(identifier) - 1);
	identifier[sizeof(identifier) - 1] = '\0';
	str identifier_str = test_str(identifier);
	assert(ivekit_guard_identifier(&identifier_str, 512));
	identifier[511] = '?';
	assert(!ivekit_guard_identifier(&identifier_str, 512));
	identifier[511] = 'x';
	identifier_str.len = 513;
	assert(!ivekit_guard_identifier(&identifier_str, 512));

	return 0;
}
